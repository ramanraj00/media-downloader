"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.MediaDownloaderStack = void 0;
const cdk = require("aws-cdk-lib");
const ec2 = require("aws-cdk-lib/aws-ec2");
const ecs = require("aws-cdk-lib/aws-ecs");
const rds = require("aws-cdk-lib/aws-rds");
const elasticache = require("aws-cdk-lib/aws-elasticache");
const s3 = require("aws-cdk-lib/aws-s3");
const iam = require("aws-cdk-lib/aws-iam");
const ssm = require("aws-cdk-lib/aws-ssm");
const logs = require("aws-cdk-lib/aws-logs");
const autoscaling = require("aws-cdk-lib/aws-autoscaling");
class MediaDownloaderStack extends cdk.Stack {
    constructor(scope, id, props) {
        super(scope, id, props);
        // 1. VPC with Private and Public Subnets
        const vpc = new ec2.Vpc(this, 'MediaDLVpc', {
            maxAzs: 2,
            natGateways: 1,
            subnetConfiguration: [
                {
                    name: 'Public',
                    subnetType: ec2.SubnetType.PUBLIC,
                },
                {
                    name: 'Private',
                    subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
                }
            ]
        });
        // S3 VPC Gateway Endpoint (Bypass NAT for S3)
        vpc.addGatewayEndpoint('S3Endpoint', {
            service: ec2.GatewayVpcEndpointAwsService.S3,
            subnets: [{ subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS }]
        });
        // 2. Storage & Databases (Private)
        const bucket = new s3.Bucket(this, 'MediaArtifactsBucket', {
            removalPolicy: cdk.RemovalPolicy.DESTROY,
            autoDeleteObjects: true,
            lifecycleRules: [
                { prefix: 'jobs/*/raw/', expiration: cdk.Duration.hours(48) },
                { prefix: 'jobs/*/processed/', expiration: cdk.Duration.hours(48) },
                { prefix: 'jobs/*/failed/', expiration: cdk.Duration.days(7) }
            ]
        });
        const dbSecurityGroup = new ec2.SecurityGroup(this, 'DbSg', { vpc });
        const database = new rds.DatabaseInstance(this, 'PostgreSQL', {
            engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_15 }),
            vpc,
            vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
            instanceType: ec2.InstanceType.of(ec2.InstanceClass.T3, ec2.InstanceSize.MICRO),
            securityGroups: [dbSecurityGroup],
            allocatedStorage: 20,
        });
        const redisSecurityGroup = new ec2.SecurityGroup(this, 'RedisSg', { vpc });
        const redisCache = new elasticache.CfnCacheCluster(this, 'Redis', {
            cacheNodeType: 'cache.t3.micro',
            engine: 'redis',
            numCacheNodes: 1,
            vpcSecurityGroupIds: [redisSecurityGroup.securityGroupId],
            cacheSubnetGroupName: new elasticache.CfnSubnetGroup(this, 'RedisSubnetGroup', {
                description: 'Subnets for Redis',
                subnetIds: vpc.privateSubnets.map(s => s.subnetId)
            }).ref
        });
        // Allow internal access
        dbSecurityGroup.addIngressRule(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.tcp(5432), 'Allow from VPC');
        redisSecurityGroup.addIngressRule(ec2.Peer.ipv4(vpc.vpcCidrBlock), ec2.Port.tcp(6379), 'Allow from VPC');
        // 3. Secrets
        const botTokenParam = ssm.StringParameter.fromSecureStringParameterAttributes(this, 'BotToken', {
            parameterName: '/mediadl/bot_token',
            version: 1,
        });
        // 4. ECS Cluster
        const cluster = new ecs.Cluster(this, 'MediaDLCluster', { vpc });
        // EC2 Spot Capacity for Workers
        const spotAsg = new autoscaling.AutoScalingGroup(this, 'SpotASG', {
            vpc,
            instanceType: new ec2.InstanceType('t3.medium'),
            machineImage: ecs.EcsOptimizedImage.amazonLinux2(),
            spotPrice: '0.02',
            minCapacity: 1,
            maxCapacity: 10,
        });
        // EC2 On-Demand Capacity for Bot/Control Plane
        const onDemandAsg = new autoscaling.AutoScalingGroup(this, 'OnDemandASG', {
            vpc,
            instanceType: new ec2.InstanceType('t3.small'),
            machineImage: ecs.EcsOptimizedImage.amazonLinux2(),
            minCapacity: 1,
            maxCapacity: 2,
        });
        const spotCapacityProvider = new ecs.AsgCapacityProvider(this, 'SpotCapacityProvider', {
            autoScalingGroup: spotAsg,
            enableManagedScaling: true,
            enableManagedTerminationProtection: false,
        });
        const onDemandCapacityProvider = new ecs.AsgCapacityProvider(this, 'OnDemandCapacityProvider', {
            autoScalingGroup: onDemandAsg,
            enableManagedScaling: true,
            enableManagedTerminationProtection: false,
        });
        cluster.addAsgCapacityProvider(spotCapacityProvider);
        cluster.addAsgCapacityProvider(onDemandCapacityProvider);
        // IAM Task Role (No Static Keys)
        const taskRole = new iam.Role(this, 'AppTaskRole', {
            assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com')
        });
        bucket.grantReadWrite(taskRole);
        const logGroup = new logs.LogGroup(this, 'MediaDLLogs', {
            retention: logs.RetentionDays.ONE_WEEK,
            removalPolicy: cdk.RemovalPolicy.DESTROY
        });
        const logging = ecs.LogDrivers.awsLogs({
            streamPrefix: 'mediadl',
            logGroup,
        });
        const environment = {
            NODE_ENV: 'production',
            REDIS_URL: `redis://${redisCache.attrRedisEndpointAddress}:${redisCache.attrRedisEndpointPort}`,
            S3_BUCKET: bucket.bucketName,
        };
        // In production we would build and push images via CI, here we use generic image for the plan
        // which CI will override.
        const ecrImage = ecs.ContainerImage.fromRegistry('mediadl-app:latest');
        // MIGRATION TASK DEFINITION
        const migrationTaskDef = new ecs.Ec2TaskDefinition(this, 'MigrationTask', { taskRole });
        migrationTaskDef.addContainer('MigrationContainer', {
            image: ecrImage,
            command: ["npx", "drizzle-kit", "migrate"],
            environment,
            secrets: {
                DATABASE_URL: ecs.Secret.fromSecretsManager(database.secret),
            },
            logging,
        });
        // Helper to create services
        const createService = (name, command, capacityProvider) => {
            const taskDef = new ecs.Ec2TaskDefinition(this, `${name}Task`, { taskRole });
            taskDef.addContainer(`${name}Container`, {
                image: ecrImage,
                memoryLimitMiB: 512,
                command,
                environment,
                secrets: {
                    DATABASE_URL: ecs.Secret.fromSecretsManager(database.secret),
                    BOT_TOKEN: ecs.Secret.fromSsmParameter(botTokenParam),
                },
                logging,
            });
            new ecs.Ec2Service(this, `${name}Service`, {
                cluster,
                taskDefinition: taskDef,
                capacityProviderStrategies: [{
                        capacityProvider,
                        weight: 1
                    }]
            });
        };
        // BOT Service (On Demand)
        createService('Bot', ['node', 'apps/bot/dist/index.js'], onDemandCapacityProvider.capacityProviderName);
        // WORKER Services (Spot)
        createService('Downloader', ['node', 'services/downloader/dist/index.js'], spotCapacityProvider.capacityProviderName);
        createService('Processor', ['node', 'services/media-processor/dist/index.js'], spotCapacityProvider.capacityProviderName);
        createService('Delivery', ['node', 'services/delivery/dist/index.js'], spotCapacityProvider.capacityProviderName);
    }
}
exports.MediaDownloaderStack = MediaDownloaderStack;
//# sourceMappingURL=data:application/json;base64,eyJ2ZXJzaW9uIjozLCJmaWxlIjoiaW5mcmEtc3RhY2suanMiLCJzb3VyY2VSb290IjoiIiwic291cmNlcyI6WyJpbmZyYS1zdGFjay50cyJdLCJuYW1lcyI6W10sIm1hcHBpbmdzIjoiOzs7QUFBQSxtQ0FBbUM7QUFFbkMsMkNBQTJDO0FBQzNDLDJDQUEyQztBQUUzQywyQ0FBMkM7QUFDM0MsMkRBQTJEO0FBQzNELHlDQUF5QztBQUN6QywyQ0FBMkM7QUFDM0MsMkNBQTJDO0FBQzNDLDZDQUE2QztBQUM3QywyREFBMkQ7QUFFM0QsTUFBYSxvQkFBcUIsU0FBUSxHQUFHLENBQUMsS0FBSztJQUNqRCxZQUFZLEtBQWdCLEVBQUUsRUFBVSxFQUFFLEtBQXNCO1FBQzlELEtBQUssQ0FBQyxLQUFLLEVBQUUsRUFBRSxFQUFFLEtBQUssQ0FBQyxDQUFDO1FBRXhCLHlDQUF5QztRQUN6QyxNQUFNLEdBQUcsR0FBRyxJQUFJLEdBQUcsQ0FBQyxHQUFHLENBQUMsSUFBSSxFQUFFLFlBQVksRUFBRTtZQUMxQyxNQUFNLEVBQUUsQ0FBQztZQUNULFdBQVcsRUFBRSxDQUFDO1lBQ2QsbUJBQW1CLEVBQUU7Z0JBQ25CO29CQUNFLElBQUksRUFBRSxRQUFRO29CQUNkLFVBQVUsRUFBRSxHQUFHLENBQUMsVUFBVSxDQUFDLE1BQU07aUJBQ2xDO2dCQUNEO29CQUNFLElBQUksRUFBRSxTQUFTO29CQUNmLFVBQVUsRUFBRSxHQUFHLENBQUMsVUFBVSxDQUFDLG1CQUFtQjtpQkFDL0M7YUFDRjtTQUNGLENBQUMsQ0FBQztRQUVILDhDQUE4QztRQUM5QyxHQUFHLENBQUMsa0JBQWtCLENBQUMsWUFBWSxFQUFFO1lBQ25DLE9BQU8sRUFBRSxHQUFHLENBQUMsNEJBQTRCLENBQUMsRUFBRTtZQUM1QyxPQUFPLEVBQUUsQ0FBQyxFQUFFLFVBQVUsRUFBRSxHQUFHLENBQUMsVUFBVSxDQUFDLG1CQUFtQixFQUFFLENBQUM7U0FDOUQsQ0FBQyxDQUFDO1FBRUgsbUNBQW1DO1FBQ25DLE1BQU0sTUFBTSxHQUFHLElBQUksRUFBRSxDQUFDLE1BQU0sQ0FBQyxJQUFJLEVBQUUsc0JBQXNCLEVBQUU7WUFDekQsYUFBYSxFQUFFLEdBQUcsQ0FBQyxhQUFhLENBQUMsT0FBTztZQUN4QyxpQkFBaUIsRUFBRSxJQUFJO1lBQ3ZCLGNBQWMsRUFBRTtnQkFDZCxFQUFFLE1BQU0sRUFBRSxhQUFhLEVBQUUsVUFBVSxFQUFFLEdBQUcsQ0FBQyxRQUFRLENBQUMsS0FBSyxDQUFDLEVBQUUsQ0FBQyxFQUFFO2dCQUM3RCxFQUFFLE1BQU0sRUFBRSxtQkFBbUIsRUFBRSxVQUFVLEVBQUUsR0FBRyxDQUFDLFFBQVEsQ0FBQyxLQUFLLENBQUMsRUFBRSxDQUFDLEVBQUU7Z0JBQ25FLEVBQUUsTUFBTSxFQUFFLGdCQUFnQixFQUFFLFVBQVUsRUFBRSxHQUFHLENBQUMsUUFBUSxDQUFDLElBQUksQ0FBQyxDQUFDLENBQUMsRUFBRTthQUMvRDtTQUNGLENBQUMsQ0FBQztRQUVILE1BQU0sZUFBZSxHQUFHLElBQUksR0FBRyxDQUFDLGFBQWEsQ0FBQyxJQUFJLEVBQUUsTUFBTSxFQUFFLEVBQUUsR0FBRyxFQUFFLENBQUMsQ0FBQztRQUNyRSxNQUFNLFFBQVEsR0FBRyxJQUFJLEdBQUcsQ0FBQyxnQkFBZ0IsQ0FBQyxJQUFJLEVBQUUsWUFBWSxFQUFFO1lBQzVELE1BQU0sRUFBRSxHQUFHLENBQUMsc0JBQXNCLENBQUMsUUFBUSxDQUFDLEVBQUUsT0FBTyxFQUFFLEdBQUcsQ0FBQyxxQkFBcUIsQ0FBQyxNQUFNLEVBQUUsQ0FBQztZQUMxRixHQUFHO1lBQ0gsVUFBVSxFQUFFLEVBQUUsVUFBVSxFQUFFLEdBQUcsQ0FBQyxVQUFVLENBQUMsbUJBQW1CLEVBQUU7WUFDOUQsWUFBWSxFQUFFLEdBQUcsQ0FBQyxZQUFZLENBQUMsRUFBRSxDQUFDLEdBQUcsQ0FBQyxhQUFhLENBQUMsRUFBRSxFQUFFLEdBQUcsQ0FBQyxZQUFZLENBQUMsS0FBSyxDQUFDO1lBQy9FLGNBQWMsRUFBRSxDQUFDLGVBQWUsQ0FBQztZQUNqQyxnQkFBZ0IsRUFBRSxFQUFFO1NBQ3JCLENBQUMsQ0FBQztRQUVILE1BQU0sa0JBQWtCLEdBQUcsSUFBSSxHQUFHLENBQUMsYUFBYSxDQUFDLElBQUksRUFBRSxTQUFTLEVBQUUsRUFBRSxHQUFHLEVBQUUsQ0FBQyxDQUFDO1FBQzNFLE1BQU0sVUFBVSxHQUFHLElBQUksV0FBVyxDQUFDLGVBQWUsQ0FBQyxJQUFJLEVBQUUsT0FBTyxFQUFFO1lBQ2hFLGFBQWEsRUFBRSxnQkFBZ0I7WUFDL0IsTUFBTSxFQUFFLE9BQU87WUFDZixhQUFhLEVBQUUsQ0FBQztZQUNoQixtQkFBbUIsRUFBRSxDQUFDLGtCQUFrQixDQUFDLGVBQWUsQ0FBQztZQUN6RCxvQkFBb0IsRUFBRSxJQUFJLFdBQVcsQ0FBQyxjQUFjLENBQUMsSUFBSSxFQUFFLGtCQUFrQixFQUFFO2dCQUM3RSxXQUFXLEVBQUUsbUJBQW1CO2dCQUNoQyxTQUFTLEVBQUUsR0FBRyxDQUFDLGNBQWMsQ0FBQyxHQUFHLENBQUMsQ0FBQyxDQUFDLEVBQUUsQ0FBQyxDQUFDLENBQUMsUUFBUSxDQUFDO2FBQ25ELENBQUMsQ0FBQyxHQUFHO1NBQ1AsQ0FBQyxDQUFDO1FBRUgsd0JBQXdCO1FBQ3hCLGVBQWUsQ0FBQyxjQUFjLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLFlBQVksQ0FBQyxFQUFFLEdBQUcsQ0FBQyxJQUFJLENBQUMsR0FBRyxDQUFDLElBQUksQ0FBQyxFQUFFLGdCQUFnQixDQUFDLENBQUM7UUFDdEcsa0JBQWtCLENBQUMsY0FBYyxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxZQUFZLENBQUMsRUFBRSxHQUFHLENBQUMsSUFBSSxDQUFDLEdBQUcsQ0FBQyxJQUFJLENBQUMsRUFBRSxnQkFBZ0IsQ0FBQyxDQUFDO1FBRXpHLGFBQWE7UUFDYixNQUFNLGFBQWEsR0FBRyxHQUFHLENBQUMsZUFBZSxDQUFDLG1DQUFtQyxDQUFDLElBQUksRUFBRSxVQUFVLEVBQUU7WUFDOUYsYUFBYSxFQUFFLG9CQUFvQjtZQUNuQyxPQUFPLEVBQUUsQ0FBQztTQUNYLENBQUMsQ0FBQztRQUVILGlCQUFpQjtRQUNqQixNQUFNLE9BQU8sR0FBRyxJQUFJLEdBQUcsQ0FBQyxPQUFPLENBQUMsSUFBSSxFQUFFLGdCQUFnQixFQUFFLEVBQUUsR0FBRyxFQUFFLENBQUMsQ0FBQztRQUVqRSxnQ0FBZ0M7UUFDaEMsTUFBTSxPQUFPLEdBQUcsSUFBSSxXQUFXLENBQUMsZ0JBQWdCLENBQUMsSUFBSSxFQUFFLFNBQVMsRUFBRTtZQUNoRSxHQUFHO1lBQ0gsWUFBWSxFQUFFLElBQUksR0FBRyxDQUFDLFlBQVksQ0FBQyxXQUFXLENBQUM7WUFDL0MsWUFBWSxFQUFFLEdBQUcsQ0FBQyxpQkFBaUIsQ0FBQyxZQUFZLEVBQUU7WUFDbEQsU0FBUyxFQUFFLE1BQU07WUFDakIsV0FBVyxFQUFFLENBQUM7WUFDZCxXQUFXLEVBQUUsRUFBRTtTQUNoQixDQUFDLENBQUM7UUFFSCwrQ0FBK0M7UUFDL0MsTUFBTSxXQUFXLEdBQUcsSUFBSSxXQUFXLENBQUMsZ0JBQWdCLENBQUMsSUFBSSxFQUFFLGFBQWEsRUFBRTtZQUN4RSxHQUFHO1lBQ0gsWUFBWSxFQUFFLElBQUksR0FBRyxDQUFDLFlBQVksQ0FBQyxVQUFVLENBQUM7WUFDOUMsWUFBWSxFQUFFLEdBQUcsQ0FBQyxpQkFBaUIsQ0FBQyxZQUFZLEVBQUU7WUFDbEQsV0FBVyxFQUFFLENBQUM7WUFDZCxXQUFXLEVBQUUsQ0FBQztTQUNmLENBQUMsQ0FBQztRQUVILE1BQU0sb0JBQW9CLEdBQUcsSUFBSSxHQUFHLENBQUMsbUJBQW1CLENBQUMsSUFBSSxFQUFFLHNCQUFzQixFQUFFO1lBQ3JGLGdCQUFnQixFQUFFLE9BQU87WUFDekIsb0JBQW9CLEVBQUUsSUFBSTtZQUMxQixrQ0FBa0MsRUFBRSxLQUFLO1NBQzFDLENBQUMsQ0FBQztRQUVILE1BQU0sd0JBQXdCLEdBQUcsSUFBSSxHQUFHLENBQUMsbUJBQW1CLENBQUMsSUFBSSxFQUFFLDBCQUEwQixFQUFFO1lBQzdGLGdCQUFnQixFQUFFLFdBQVc7WUFDN0Isb0JBQW9CLEVBQUUsSUFBSTtZQUMxQixrQ0FBa0MsRUFBRSxLQUFLO1NBQzFDLENBQUMsQ0FBQztRQUVILE9BQU8sQ0FBQyxzQkFBc0IsQ0FBQyxvQkFBb0IsQ0FBQyxDQUFDO1FBQ3JELE9BQU8sQ0FBQyxzQkFBc0IsQ0FBQyx3QkFBd0IsQ0FBQyxDQUFDO1FBRXpELGlDQUFpQztRQUNqQyxNQUFNLFFBQVEsR0FBRyxJQUFJLEdBQUcsQ0FBQyxJQUFJLENBQUMsSUFBSSxFQUFFLGFBQWEsRUFBRTtZQUNqRCxTQUFTLEVBQUUsSUFBSSxHQUFHLENBQUMsZ0JBQWdCLENBQUMseUJBQXlCLENBQUM7U0FDL0QsQ0FBQyxDQUFDO1FBQ0gsTUFBTSxDQUFDLGNBQWMsQ0FBQyxRQUFRLENBQUMsQ0FBQztRQUVoQyxNQUFNLFFBQVEsR0FBRyxJQUFJLElBQUksQ0FBQyxRQUFRLENBQUMsSUFBSSxFQUFFLGFBQWEsRUFBRTtZQUN0RCxTQUFTLEVBQUUsSUFBSSxDQUFDLGFBQWEsQ0FBQyxRQUFRO1lBQ3RDLGFBQWEsRUFBRSxHQUFHLENBQUMsYUFBYSxDQUFDLE9BQU87U0FDekMsQ0FBQyxDQUFDO1FBRUgsTUFBTSxPQUFPLEdBQUcsR0FBRyxDQUFDLFVBQVUsQ0FBQyxPQUFPLENBQUM7WUFDckMsWUFBWSxFQUFFLFNBQVM7WUFDdkIsUUFBUTtTQUNULENBQUMsQ0FBQztRQUVILE1BQU0sV0FBVyxHQUFHO1lBQ2xCLFFBQVEsRUFBRSxZQUFZO1lBQ3RCLFNBQVMsRUFBRSxXQUFXLFVBQVUsQ0FBQyx3QkFBd0IsSUFBSSxVQUFVLENBQUMscUJBQXFCLEVBQUU7WUFDL0YsU0FBUyxFQUFFLE1BQU0sQ0FBQyxVQUFVO1NBQzdCLENBQUM7UUFFRiw4RkFBOEY7UUFDOUYsMEJBQTBCO1FBQzFCLE1BQU0sUUFBUSxHQUFHLEdBQUcsQ0FBQyxjQUFjLENBQUMsWUFBWSxDQUFDLG9CQUFvQixDQUFDLENBQUM7UUFFdkUsNEJBQTRCO1FBQzVCLE1BQU0sZ0JBQWdCLEdBQUcsSUFBSSxHQUFHLENBQUMsaUJBQWlCLENBQUMsSUFBSSxFQUFFLGVBQWUsRUFBRSxFQUFFLFFBQVEsRUFBRSxDQUFDLENBQUM7UUFDeEYsZ0JBQWdCLENBQUMsWUFBWSxDQUFDLG9CQUFvQixFQUFFO1lBQ2xELEtBQUssRUFBRSxRQUFRO1lBQ2YsT0FBTyxFQUFFLENBQUMsS0FBSyxFQUFFLGFBQWEsRUFBRSxTQUFTLENBQUM7WUFDMUMsV0FBVztZQUNYLE9BQU8sRUFBRTtnQkFDUCxZQUFZLEVBQUUsR0FBRyxDQUFDLE1BQU0sQ0FBQyxrQkFBa0IsQ0FBQyxRQUFRLENBQUMsTUFBTyxDQUFDO2FBQzlEO1lBQ0QsT0FBTztTQUNSLENBQUMsQ0FBQztRQUVILDRCQUE0QjtRQUM1QixNQUFNLGFBQWEsR0FBRyxDQUFDLElBQVksRUFBRSxPQUFpQixFQUFFLGdCQUF3QixFQUFFLEVBQUU7WUFDbEYsTUFBTSxPQUFPLEdBQUcsSUFBSSxHQUFHLENBQUMsaUJBQWlCLENBQUMsSUFBSSxFQUFFLEdBQUcsSUFBSSxNQUFNLEVBQUUsRUFBRSxRQUFRLEVBQUUsQ0FBQyxDQUFDO1lBQzdFLE9BQU8sQ0FBQyxZQUFZLENBQUMsR0FBRyxJQUFJLFdBQVcsRUFBRTtnQkFDdkMsS0FBSyxFQUFFLFFBQVE7Z0JBQ2YsY0FBYyxFQUFFLEdBQUc7Z0JBQ25CLE9BQU87Z0JBQ1AsV0FBVztnQkFDWCxPQUFPLEVBQUU7b0JBQ1AsWUFBWSxFQUFFLEdBQUcsQ0FBQyxNQUFNLENBQUMsa0JBQWtCLENBQUMsUUFBUSxDQUFDLE1BQU8sQ0FBQztvQkFDN0QsU0FBUyxFQUFFLEdBQUcsQ0FBQyxNQUFNLENBQUMsZ0JBQWdCLENBQUMsYUFBYSxDQUFDO2lCQUN0RDtnQkFDRCxPQUFPO2FBQ1IsQ0FBQyxDQUFDO1lBRUgsSUFBSSxHQUFHLENBQUMsVUFBVSxDQUFDLElBQUksRUFBRSxHQUFHLElBQUksU0FBUyxFQUFFO2dCQUN6QyxPQUFPO2dCQUNQLGNBQWMsRUFBRSxPQUFPO2dCQUN2QiwwQkFBMEIsRUFBRSxDQUFDO3dCQUMzQixnQkFBZ0I7d0JBQ2hCLE1BQU0sRUFBRSxDQUFDO3FCQUNWLENBQUM7YUFDSCxDQUFDLENBQUM7UUFDTCxDQUFDLENBQUM7UUFFRiwwQkFBMEI7UUFDMUIsYUFBYSxDQUFDLEtBQUssRUFBRSxDQUFDLE1BQU0sRUFBRSx3QkFBd0IsQ0FBQyxFQUFFLHdCQUF3QixDQUFDLG9CQUFvQixDQUFDLENBQUM7UUFFeEcseUJBQXlCO1FBQ3pCLGFBQWEsQ0FBQyxZQUFZLEVBQUUsQ0FBQyxNQUFNLEVBQUUsbUNBQW1DLENBQUMsRUFBRSxvQkFBb0IsQ0FBQyxvQkFBb0IsQ0FBQyxDQUFDO1FBQ3RILGFBQWEsQ0FBQyxXQUFXLEVBQUUsQ0FBQyxNQUFNLEVBQUUsd0NBQXdDLENBQUMsRUFBRSxvQkFBb0IsQ0FBQyxvQkFBb0IsQ0FBQyxDQUFDO1FBQzFILGFBQWEsQ0FBQyxVQUFVLEVBQUUsQ0FBQyxNQUFNLEVBQUUsaUNBQWlDLENBQUMsRUFBRSxvQkFBb0IsQ0FBQyxvQkFBb0IsQ0FBQyxDQUFDO0lBQ3BILENBQUM7Q0FDRjtBQWpMRCxvREFpTEMiLCJzb3VyY2VzQ29udGVudCI6WyJpbXBvcnQgKiBhcyBjZGsgZnJvbSAnYXdzLWNkay1saWInO1xuaW1wb3J0IHsgQ29uc3RydWN0IH0gZnJvbSAnY29uc3RydWN0cyc7XG5pbXBvcnQgKiBhcyBlYzIgZnJvbSAnYXdzLWNkay1saWIvYXdzLWVjMic7XG5pbXBvcnQgKiBhcyBlY3MgZnJvbSAnYXdzLWNkay1saWIvYXdzLWVjcyc7XG5pbXBvcnQgKiBhcyBlY3IgZnJvbSAnYXdzLWNkay1saWIvYXdzLWVjcic7XG5pbXBvcnQgKiBhcyByZHMgZnJvbSAnYXdzLWNkay1saWIvYXdzLXJkcyc7XG5pbXBvcnQgKiBhcyBlbGFzdGljYWNoZSBmcm9tICdhd3MtY2RrLWxpYi9hd3MtZWxhc3RpY2FjaGUnO1xuaW1wb3J0ICogYXMgczMgZnJvbSAnYXdzLWNkay1saWIvYXdzLXMzJztcbmltcG9ydCAqIGFzIGlhbSBmcm9tICdhd3MtY2RrLWxpYi9hd3MtaWFtJztcbmltcG9ydCAqIGFzIHNzbSBmcm9tICdhd3MtY2RrLWxpYi9hd3Mtc3NtJztcbmltcG9ydCAqIGFzIGxvZ3MgZnJvbSAnYXdzLWNkay1saWIvYXdzLWxvZ3MnO1xuaW1wb3J0ICogYXMgYXV0b3NjYWxpbmcgZnJvbSAnYXdzLWNkay1saWIvYXdzLWF1dG9zY2FsaW5nJztcblxuZXhwb3J0IGNsYXNzIE1lZGlhRG93bmxvYWRlclN0YWNrIGV4dGVuZHMgY2RrLlN0YWNrIHtcbiAgY29uc3RydWN0b3Ioc2NvcGU6IENvbnN0cnVjdCwgaWQ6IHN0cmluZywgcHJvcHM/OiBjZGsuU3RhY2tQcm9wcykge1xuICAgIHN1cGVyKHNjb3BlLCBpZCwgcHJvcHMpO1xuXG4gICAgLy8gMS4gVlBDIHdpdGggUHJpdmF0ZSBhbmQgUHVibGljIFN1Ym5ldHNcbiAgICBjb25zdCB2cGMgPSBuZXcgZWMyLlZwYyh0aGlzLCAnTWVkaWFETFZwYycsIHtcbiAgICAgIG1heEF6czogMixcbiAgICAgIG5hdEdhdGV3YXlzOiAxLFxuICAgICAgc3VibmV0Q29uZmlndXJhdGlvbjogW1xuICAgICAgICB7XG4gICAgICAgICAgbmFtZTogJ1B1YmxpYycsXG4gICAgICAgICAgc3VibmV0VHlwZTogZWMyLlN1Ym5ldFR5cGUuUFVCTElDLFxuICAgICAgICB9LFxuICAgICAgICB7XG4gICAgICAgICAgbmFtZTogJ1ByaXZhdGUnLFxuICAgICAgICAgIHN1Ym5ldFR5cGU6IGVjMi5TdWJuZXRUeXBlLlBSSVZBVEVfV0lUSF9FR1JFU1MsXG4gICAgICAgIH1cbiAgICAgIF1cbiAgICB9KTtcblxuICAgIC8vIFMzIFZQQyBHYXRld2F5IEVuZHBvaW50IChCeXBhc3MgTkFUIGZvciBTMylcbiAgICB2cGMuYWRkR2F0ZXdheUVuZHBvaW50KCdTM0VuZHBvaW50Jywge1xuICAgICAgc2VydmljZTogZWMyLkdhdGV3YXlWcGNFbmRwb2ludEF3c1NlcnZpY2UuUzMsXG4gICAgICBzdWJuZXRzOiBbeyBzdWJuZXRUeXBlOiBlYzIuU3VibmV0VHlwZS5QUklWQVRFX1dJVEhfRUdSRVNTIH1dXG4gICAgfSk7XG5cbiAgICAvLyAyLiBTdG9yYWdlICYgRGF0YWJhc2VzIChQcml2YXRlKVxuICAgIGNvbnN0IGJ1Y2tldCA9IG5ldyBzMy5CdWNrZXQodGhpcywgJ01lZGlhQXJ0aWZhY3RzQnVja2V0Jywge1xuICAgICAgcmVtb3ZhbFBvbGljeTogY2RrLlJlbW92YWxQb2xpY3kuREVTVFJPWSxcbiAgICAgIGF1dG9EZWxldGVPYmplY3RzOiB0cnVlLFxuICAgICAgbGlmZWN5Y2xlUnVsZXM6IFtcbiAgICAgICAgeyBwcmVmaXg6ICdqb2JzLyovcmF3LycsIGV4cGlyYXRpb246IGNkay5EdXJhdGlvbi5ob3Vycyg0OCkgfSxcbiAgICAgICAgeyBwcmVmaXg6ICdqb2JzLyovcHJvY2Vzc2VkLycsIGV4cGlyYXRpb246IGNkay5EdXJhdGlvbi5ob3Vycyg0OCkgfSxcbiAgICAgICAgeyBwcmVmaXg6ICdqb2JzLyovZmFpbGVkLycsIGV4cGlyYXRpb246IGNkay5EdXJhdGlvbi5kYXlzKDcpIH1cbiAgICAgIF1cbiAgICB9KTtcblxuICAgIGNvbnN0IGRiU2VjdXJpdHlHcm91cCA9IG5ldyBlYzIuU2VjdXJpdHlHcm91cCh0aGlzLCAnRGJTZycsIHsgdnBjIH0pO1xuICAgIGNvbnN0IGRhdGFiYXNlID0gbmV3IHJkcy5EYXRhYmFzZUluc3RhbmNlKHRoaXMsICdQb3N0Z3JlU1FMJywge1xuICAgICAgZW5naW5lOiByZHMuRGF0YWJhc2VJbnN0YW5jZUVuZ2luZS5wb3N0Z3Jlcyh7IHZlcnNpb246IHJkcy5Qb3N0Z3Jlc0VuZ2luZVZlcnNpb24uVkVSXzE1IH0pLFxuICAgICAgdnBjLFxuICAgICAgdnBjU3VibmV0czogeyBzdWJuZXRUeXBlOiBlYzIuU3VibmV0VHlwZS5QUklWQVRFX1dJVEhfRUdSRVNTIH0sXG4gICAgICBpbnN0YW5jZVR5cGU6IGVjMi5JbnN0YW5jZVR5cGUub2YoZWMyLkluc3RhbmNlQ2xhc3MuVDMsIGVjMi5JbnN0YW5jZVNpemUuTUlDUk8pLFxuICAgICAgc2VjdXJpdHlHcm91cHM6IFtkYlNlY3VyaXR5R3JvdXBdLFxuICAgICAgYWxsb2NhdGVkU3RvcmFnZTogMjAsXG4gICAgfSk7XG5cbiAgICBjb25zdCByZWRpc1NlY3VyaXR5R3JvdXAgPSBuZXcgZWMyLlNlY3VyaXR5R3JvdXAodGhpcywgJ1JlZGlzU2cnLCB7IHZwYyB9KTtcbiAgICBjb25zdCByZWRpc0NhY2hlID0gbmV3IGVsYXN0aWNhY2hlLkNmbkNhY2hlQ2x1c3Rlcih0aGlzLCAnUmVkaXMnLCB7XG4gICAgICBjYWNoZU5vZGVUeXBlOiAnY2FjaGUudDMubWljcm8nLFxuICAgICAgZW5naW5lOiAncmVkaXMnLFxuICAgICAgbnVtQ2FjaGVOb2RlczogMSxcbiAgICAgIHZwY1NlY3VyaXR5R3JvdXBJZHM6IFtyZWRpc1NlY3VyaXR5R3JvdXAuc2VjdXJpdHlHcm91cElkXSxcbiAgICAgIGNhY2hlU3VibmV0R3JvdXBOYW1lOiBuZXcgZWxhc3RpY2FjaGUuQ2ZuU3VibmV0R3JvdXAodGhpcywgJ1JlZGlzU3VibmV0R3JvdXAnLCB7XG4gICAgICAgIGRlc2NyaXB0aW9uOiAnU3VibmV0cyBmb3IgUmVkaXMnLFxuICAgICAgICBzdWJuZXRJZHM6IHZwYy5wcml2YXRlU3VibmV0cy5tYXAocyA9PiBzLnN1Ym5ldElkKVxuICAgICAgfSkucmVmXG4gICAgfSk7XG5cbiAgICAvLyBBbGxvdyBpbnRlcm5hbCBhY2Nlc3NcbiAgICBkYlNlY3VyaXR5R3JvdXAuYWRkSW5ncmVzc1J1bGUoZWMyLlBlZXIuaXB2NCh2cGMudnBjQ2lkckJsb2NrKSwgZWMyLlBvcnQudGNwKDU0MzIpLCAnQWxsb3cgZnJvbSBWUEMnKTtcbiAgICByZWRpc1NlY3VyaXR5R3JvdXAuYWRkSW5ncmVzc1J1bGUoZWMyLlBlZXIuaXB2NCh2cGMudnBjQ2lkckJsb2NrKSwgZWMyLlBvcnQudGNwKDYzNzkpLCAnQWxsb3cgZnJvbSBWUEMnKTtcblxuICAgIC8vIDMuIFNlY3JldHNcbiAgICBjb25zdCBib3RUb2tlblBhcmFtID0gc3NtLlN0cmluZ1BhcmFtZXRlci5mcm9tU2VjdXJlU3RyaW5nUGFyYW1ldGVyQXR0cmlidXRlcyh0aGlzLCAnQm90VG9rZW4nLCB7XG4gICAgICBwYXJhbWV0ZXJOYW1lOiAnL21lZGlhZGwvYm90X3Rva2VuJyxcbiAgICAgIHZlcnNpb246IDEsXG4gICAgfSk7XG5cbiAgICAvLyA0LiBFQ1MgQ2x1c3RlclxuICAgIGNvbnN0IGNsdXN0ZXIgPSBuZXcgZWNzLkNsdXN0ZXIodGhpcywgJ01lZGlhRExDbHVzdGVyJywgeyB2cGMgfSk7XG5cbiAgICAvLyBFQzIgU3BvdCBDYXBhY2l0eSBmb3IgV29ya2Vyc1xuICAgIGNvbnN0IHNwb3RBc2cgPSBuZXcgYXV0b3NjYWxpbmcuQXV0b1NjYWxpbmdHcm91cCh0aGlzLCAnU3BvdEFTRycsIHtcbiAgICAgIHZwYyxcbiAgICAgIGluc3RhbmNlVHlwZTogbmV3IGVjMi5JbnN0YW5jZVR5cGUoJ3QzLm1lZGl1bScpLFxuICAgICAgbWFjaGluZUltYWdlOiBlY3MuRWNzT3B0aW1pemVkSW1hZ2UuYW1hem9uTGludXgyKCksXG4gICAgICBzcG90UHJpY2U6ICcwLjAyJywgLy8gU3BvdCBmYWxsYmFja1xuICAgICAgbWluQ2FwYWNpdHk6IDEsXG4gICAgICBtYXhDYXBhY2l0eTogMTAsXG4gICAgfSk7XG5cbiAgICAvLyBFQzIgT24tRGVtYW5kIENhcGFjaXR5IGZvciBCb3QvQ29udHJvbCBQbGFuZVxuICAgIGNvbnN0IG9uRGVtYW5kQXNnID0gbmV3IGF1dG9zY2FsaW5nLkF1dG9TY2FsaW5nR3JvdXAodGhpcywgJ09uRGVtYW5kQVNHJywge1xuICAgICAgdnBjLFxuICAgICAgaW5zdGFuY2VUeXBlOiBuZXcgZWMyLkluc3RhbmNlVHlwZSgndDMuc21hbGwnKSxcbiAgICAgIG1hY2hpbmVJbWFnZTogZWNzLkVjc09wdGltaXplZEltYWdlLmFtYXpvbkxpbnV4MigpLFxuICAgICAgbWluQ2FwYWNpdHk6IDEsXG4gICAgICBtYXhDYXBhY2l0eTogMixcbiAgICB9KTtcblxuICAgIGNvbnN0IHNwb3RDYXBhY2l0eVByb3ZpZGVyID0gbmV3IGVjcy5Bc2dDYXBhY2l0eVByb3ZpZGVyKHRoaXMsICdTcG90Q2FwYWNpdHlQcm92aWRlcicsIHtcbiAgICAgIGF1dG9TY2FsaW5nR3JvdXA6IHNwb3RBc2csXG4gICAgICBlbmFibGVNYW5hZ2VkU2NhbGluZzogdHJ1ZSxcbiAgICAgIGVuYWJsZU1hbmFnZWRUZXJtaW5hdGlvblByb3RlY3Rpb246IGZhbHNlLFxuICAgIH0pO1xuXG4gICAgY29uc3Qgb25EZW1hbmRDYXBhY2l0eVByb3ZpZGVyID0gbmV3IGVjcy5Bc2dDYXBhY2l0eVByb3ZpZGVyKHRoaXMsICdPbkRlbWFuZENhcGFjaXR5UHJvdmlkZXInLCB7XG4gICAgICBhdXRvU2NhbGluZ0dyb3VwOiBvbkRlbWFuZEFzZyxcbiAgICAgIGVuYWJsZU1hbmFnZWRTY2FsaW5nOiB0cnVlLFxuICAgICAgZW5hYmxlTWFuYWdlZFRlcm1pbmF0aW9uUHJvdGVjdGlvbjogZmFsc2UsXG4gICAgfSk7XG5cbiAgICBjbHVzdGVyLmFkZEFzZ0NhcGFjaXR5UHJvdmlkZXIoc3BvdENhcGFjaXR5UHJvdmlkZXIpO1xuICAgIGNsdXN0ZXIuYWRkQXNnQ2FwYWNpdHlQcm92aWRlcihvbkRlbWFuZENhcGFjaXR5UHJvdmlkZXIpO1xuXG4gICAgLy8gSUFNIFRhc2sgUm9sZSAoTm8gU3RhdGljIEtleXMpXG4gICAgY29uc3QgdGFza1JvbGUgPSBuZXcgaWFtLlJvbGUodGhpcywgJ0FwcFRhc2tSb2xlJywge1xuICAgICAgYXNzdW1lZEJ5OiBuZXcgaWFtLlNlcnZpY2VQcmluY2lwYWwoJ2Vjcy10YXNrcy5hbWF6b25hd3MuY29tJylcbiAgICB9KTtcbiAgICBidWNrZXQuZ3JhbnRSZWFkV3JpdGUodGFza1JvbGUpO1xuXG4gICAgY29uc3QgbG9nR3JvdXAgPSBuZXcgbG9ncy5Mb2dHcm91cCh0aGlzLCAnTWVkaWFETExvZ3MnLCB7XG4gICAgICByZXRlbnRpb246IGxvZ3MuUmV0ZW50aW9uRGF5cy5PTkVfV0VFSyxcbiAgICAgIHJlbW92YWxQb2xpY3k6IGNkay5SZW1vdmFsUG9saWN5LkRFU1RST1lcbiAgICB9KTtcblxuICAgIGNvbnN0IGxvZ2dpbmcgPSBlY3MuTG9nRHJpdmVycy5hd3NMb2dzKHtcbiAgICAgIHN0cmVhbVByZWZpeDogJ21lZGlhZGwnLFxuICAgICAgbG9nR3JvdXAsXG4gICAgfSk7XG5cbiAgICBjb25zdCBlbnZpcm9ubWVudCA9IHtcbiAgICAgIE5PREVfRU5WOiAncHJvZHVjdGlvbicsXG4gICAgICBSRURJU19VUkw6IGByZWRpczovLyR7cmVkaXNDYWNoZS5hdHRyUmVkaXNFbmRwb2ludEFkZHJlc3N9OiR7cmVkaXNDYWNoZS5hdHRyUmVkaXNFbmRwb2ludFBvcnR9YCxcbiAgICAgIFMzX0JVQ0tFVDogYnVja2V0LmJ1Y2tldE5hbWUsXG4gICAgfTtcbiAgICBcbiAgICAvLyBJbiBwcm9kdWN0aW9uIHdlIHdvdWxkIGJ1aWxkIGFuZCBwdXNoIGltYWdlcyB2aWEgQ0ksIGhlcmUgd2UgdXNlIGdlbmVyaWMgaW1hZ2UgZm9yIHRoZSBwbGFuXG4gICAgLy8gd2hpY2ggQ0kgd2lsbCBvdmVycmlkZS5cbiAgICBjb25zdCBlY3JJbWFnZSA9IGVjcy5Db250YWluZXJJbWFnZS5mcm9tUmVnaXN0cnkoJ21lZGlhZGwtYXBwOmxhdGVzdCcpO1xuXG4gICAgLy8gTUlHUkFUSU9OIFRBU0sgREVGSU5JVElPTlxuICAgIGNvbnN0IG1pZ3JhdGlvblRhc2tEZWYgPSBuZXcgZWNzLkVjMlRhc2tEZWZpbml0aW9uKHRoaXMsICdNaWdyYXRpb25UYXNrJywgeyB0YXNrUm9sZSB9KTtcbiAgICBtaWdyYXRpb25UYXNrRGVmLmFkZENvbnRhaW5lcignTWlncmF0aW9uQ29udGFpbmVyJywge1xuICAgICAgaW1hZ2U6IGVjckltYWdlLFxuICAgICAgY29tbWFuZDogW1wibnB4XCIsIFwiZHJpenpsZS1raXRcIiwgXCJtaWdyYXRlXCJdLFxuICAgICAgZW52aXJvbm1lbnQsXG4gICAgICBzZWNyZXRzOiB7XG4gICAgICAgIERBVEFCQVNFX1VSTDogZWNzLlNlY3JldC5mcm9tU2VjcmV0c01hbmFnZXIoZGF0YWJhc2Uuc2VjcmV0ISksXG4gICAgICB9LFxuICAgICAgbG9nZ2luZyxcbiAgICB9KTtcblxuICAgIC8vIEhlbHBlciB0byBjcmVhdGUgc2VydmljZXNcbiAgICBjb25zdCBjcmVhdGVTZXJ2aWNlID0gKG5hbWU6IHN0cmluZywgY29tbWFuZDogc3RyaW5nW10sIGNhcGFjaXR5UHJvdmlkZXI6IHN0cmluZykgPT4ge1xuICAgICAgY29uc3QgdGFza0RlZiA9IG5ldyBlY3MuRWMyVGFza0RlZmluaXRpb24odGhpcywgYCR7bmFtZX1UYXNrYCwgeyB0YXNrUm9sZSB9KTtcbiAgICAgIHRhc2tEZWYuYWRkQ29udGFpbmVyKGAke25hbWV9Q29udGFpbmVyYCwge1xuICAgICAgICBpbWFnZTogZWNySW1hZ2UsXG4gICAgICAgIG1lbW9yeUxpbWl0TWlCOiA1MTIsXG4gICAgICAgIGNvbW1hbmQsXG4gICAgICAgIGVudmlyb25tZW50LFxuICAgICAgICBzZWNyZXRzOiB7XG4gICAgICAgICAgREFUQUJBU0VfVVJMOiBlY3MuU2VjcmV0LmZyb21TZWNyZXRzTWFuYWdlcihkYXRhYmFzZS5zZWNyZXQhKSxcbiAgICAgICAgICBCT1RfVE9LRU46IGVjcy5TZWNyZXQuZnJvbVNzbVBhcmFtZXRlcihib3RUb2tlblBhcmFtKSxcbiAgICAgICAgfSxcbiAgICAgICAgbG9nZ2luZyxcbiAgICAgIH0pO1xuXG4gICAgICBuZXcgZWNzLkVjMlNlcnZpY2UodGhpcywgYCR7bmFtZX1TZXJ2aWNlYCwge1xuICAgICAgICBjbHVzdGVyLFxuICAgICAgICB0YXNrRGVmaW5pdGlvbjogdGFza0RlZixcbiAgICAgICAgY2FwYWNpdHlQcm92aWRlclN0cmF0ZWdpZXM6IFt7XG4gICAgICAgICAgY2FwYWNpdHlQcm92aWRlcixcbiAgICAgICAgICB3ZWlnaHQ6IDFcbiAgICAgICAgfV1cbiAgICAgIH0pO1xuICAgIH07XG5cbiAgICAvLyBCT1QgU2VydmljZSAoT24gRGVtYW5kKVxuICAgIGNyZWF0ZVNlcnZpY2UoJ0JvdCcsIFsnbm9kZScsICdhcHBzL2JvdC9kaXN0L2luZGV4LmpzJ10sIG9uRGVtYW5kQ2FwYWNpdHlQcm92aWRlci5jYXBhY2l0eVByb3ZpZGVyTmFtZSk7XG5cbiAgICAvLyBXT1JLRVIgU2VydmljZXMgKFNwb3QpXG4gICAgY3JlYXRlU2VydmljZSgnRG93bmxvYWRlcicsIFsnbm9kZScsICdzZXJ2aWNlcy9kb3dubG9hZGVyL2Rpc3QvaW5kZXguanMnXSwgc3BvdENhcGFjaXR5UHJvdmlkZXIuY2FwYWNpdHlQcm92aWRlck5hbWUpO1xuICAgIGNyZWF0ZVNlcnZpY2UoJ1Byb2Nlc3NvcicsIFsnbm9kZScsICdzZXJ2aWNlcy9tZWRpYS1wcm9jZXNzb3IvZGlzdC9pbmRleC5qcyddLCBzcG90Q2FwYWNpdHlQcm92aWRlci5jYXBhY2l0eVByb3ZpZGVyTmFtZSk7XG4gICAgY3JlYXRlU2VydmljZSgnRGVsaXZlcnknLCBbJ25vZGUnLCAnc2VydmljZXMvZGVsaXZlcnkvZGlzdC9pbmRleC5qcyddLCBzcG90Q2FwYWNpdHlQcm92aWRlci5jYXBhY2l0eVByb3ZpZGVyTmFtZSk7XG4gIH1cbn1cbiJdfQ==
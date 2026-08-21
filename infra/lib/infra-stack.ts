import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as elasticache from 'aws-cdk-lib/aws-elasticache';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ssm from 'aws-cdk-lib/aws-ssm';
import * as logs from 'aws-cdk-lib/aws-logs';

export class MediaDownloaderStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
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
    const spotAsg = cluster.addCapacity('SpotASG', {
      instanceType: new ec2.InstanceType('t3.medium'),
      machineImage: ecs.EcsOptimizedImage.amazonLinux2(),
      spotPrice: '0.02', // Spot fallback
      minCapacity: 1,
      maxCapacity: 10,
    });

    // EC2 On-Demand Capacity for Bot/Control Plane
    const onDemandAsg = cluster.addCapacity('OnDemandASG', {
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
        DATABASE_URL: ecs.Secret.fromSecretsManager(database.secret!),
      },
      logging,
    });

    // Helper to create services
    const createService = (name: string, command: string[], capacityProvider: string) => {
      const taskDef = new ecs.Ec2TaskDefinition(this, `${name}Task`, { taskRole });
      taskDef.addContainer(`${name}Container`, {
        image: ecrImage,
        memoryLimitMiB: 512,
        command,
        environment,
        secrets: {
          DATABASE_URL: ecs.Secret.fromSecretsManager(database.secret!),
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

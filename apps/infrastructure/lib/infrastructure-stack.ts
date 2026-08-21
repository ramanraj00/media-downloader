import * as cdk from 'aws-cdk-lib';
import { Construct } from 'constructs';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as rds from 'aws-cdk-lib/aws-rds';
import * as elasticache from 'aws-cdk-lib/aws-elasticache';
import * as ecs from 'aws-cdk-lib/aws-ecs';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as iam from 'aws-cdk-lib/aws-iam';

export class InfrastructureStack extends cdk.Stack {
  constructor(scope: Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // 1. VPC with 1 NAT Gateway for cost-efficiency (used by ECS Spot instances)
    const vpc = new ec2.Vpc(this, 'MediaDownloaderVpc', {
      maxAzs: 2,
      natGateways: 1, // Minimize cost while allowing outbound internet
      subnetConfiguration: [
        {
          cidrMask: 24,
          name: 'ingress',
          subnetType: ec2.SubnetType.PUBLIC,
        },
        {
          cidrMask: 24,
          name: 'application',
          subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
        },
        {
          cidrMask: 28,
          name: 'rds',
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
        }
      ],
    });

    // S3 Gateway Endpoint to avoid NAT charges for S3 traffic
    vpc.addGatewayEndpoint('S3Endpoint', {
      service: ec2.GatewayVpcEndpointAwsService.S3,
    });

    // 2. PostgreSQL RDS Database
    const dbSecurityGroup = new ec2.SecurityGroup(this, 'DbSecurityGroup', { vpc });
    
    const database = new rds.DatabaseInstance(this, 'Database', {
      engine: rds.DatabaseInstanceEngine.postgres({ version: rds.PostgresEngineVersion.VER_15 }),
      instanceType: ec2.InstanceType.of(ec2.InstanceClass.T4G, ec2.InstanceSize.MICRO),
      vpc,
      vpcSubnets: {
        subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
      },
      securityGroups: [dbSecurityGroup],
      allocatedStorage: 20,
      multiAz: false,
      deletionProtection: false, // For staging
    });

    // 3. ElastiCache Redis
    const redisSecurityGroup = new ec2.SecurityGroup(this, 'RedisSecurityGroup', { vpc });
    
    const redisSubnetGroup = new elasticache.CfnSubnetGroup(this, 'RedisSubnetGroup', {
      description: 'Subnets for Redis',
      subnetIds: vpc.isolatedSubnets.map(s => s.subnetId),
    });

    const redis = new elasticache.CfnCacheCluster(this, 'RedisCluster', {
      cacheNodeType: 'cache.t4g.micro',
      engine: 'redis',
      numCacheNodes: 1,
      vpcSecurityGroupIds: [redisSecurityGroup.securityGroupId],
      cacheSubnetGroupName: redisSubnetGroup.ref,
    });

    // Allow ECS to access RDS and Redis
    const ecsSecurityGroup = new ec2.SecurityGroup(this, 'EcsSecurityGroup', { vpc });
    dbSecurityGroup.addIngressRule(ecsSecurityGroup, ec2.Port.tcp(5432), 'Allow ECS access to RDS');
    redisSecurityGroup.addIngressRule(ecsSecurityGroup, ec2.Port.tcp(6379), 'Allow ECS access to Redis');

    // 4. S3 Bucket for Artifacts
    const artifactBucket = new s3.Bucket(this, 'ArtifactBucket', {
      bucketName: `media-downloader-artifacts-${this.account}-${this.region}`,
      removalPolicy: cdk.RemovalPolicy.DESTROY,
      autoDeleteObjects: true,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      lifecycleRules: [
        {
          expiration: cdk.Duration.days(7), // Keep artifacts for 7 days
        }
      ]
    });

    // 5. IAM Roles
    const taskExecutionRole = new iam.Role(this, 'TaskExecutionRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
      managedPolicies: [
        iam.ManagedPolicy.fromAwsManagedPolicyName('service-role/AmazonECSTaskExecutionRolePolicy'),
      ],
    });

    const taskRole = new iam.Role(this, 'TaskRole', {
      assumedBy: new iam.ServicePrincipal('ecs-tasks.amazonaws.com'),
    });

    // Strictly scoped S3 permissions (no static keys)
    artifactBucket.grantReadWrite(taskRole);

    // 6. ECS Cluster with Fargate Spot
    const cluster = new ecs.Cluster(this, 'MediaCluster', {
      vpc,
      enableFargateCapacityProviders: true,
    });

    // 7. Base Task Definition
    const environment = {
      NODE_ENV: 'production',
      REDIS_URL: `redis://${redis.attrRedisEndpointAddress}:${redis.attrRedisEndpointPort}`,
      S3_BUCKET: artifactBucket.bucketName,
      BOT_TOKEN: 'test_bot_token_do_not_use_in_prod', 
    };

    const createTask = (name: string, packageName: string, memoryLimitMiB = 512, cpu = 256) => {
      const taskDef = new ecs.FargateTaskDefinition(this, `${name}TaskDef`, {
        memoryLimitMiB,
        cpu,
        taskRole,
        executionRole: taskExecutionRole,
        runtimePlatform: {
          operatingSystemFamily: ecs.OperatingSystemFamily.LINUX,
          cpuArchitecture: ecs.CpuArchitecture.ARM64,
        },
      });

      if (database.secret) {
        taskDef.addContainer(`${name}Container`, {
          image: ecs.ContainerImage.fromAsset('../../', {
            exclude: ['**/cdk.out', '**/node_modules', '.git'],
          }),
          command: ['sh', '-c', `export DATABASE_URL="postgresql://"$DB_USER":"$DB_PASSWORD"@${database.instanceEndpoint.socketAddress}/postgres?sslmode=require" && npm run start -w ${packageName}`],
          environment,
          secrets: {
            DB_PASSWORD: ecs.Secret.fromSecretsManager(database.secret, 'password'),
            DB_USER: ecs.Secret.fromSecretsManager(database.secret, 'username'),
          },
          logging: ecs.LogDrivers.awsLogs({ streamPrefix: name }),
        });
      }

      new ecs.FargateService(this, `${name}Service`, {
        cluster,
        taskDefinition: taskDef,
        securityGroups: [ecsSecurityGroup],
        capacityProviderStrategies: [
          {
            capacityProvider: 'FARGATE_SPOT',
            weight: 1,
          }
        ],
      });
    };

    // Services
    createTask('Downloader', '@media-downloader/downloader');
    createTask('Processor', '@media-downloader/media-processor');
    createTask('Delivery', '@media-downloader/delivery');
    createTask('Relay', '@media-downloader/outbox-publisher');
  }
}

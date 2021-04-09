import * as pulumi from '@pulumi/pulumi';
import * as aws from '@pulumi/aws';
import * as random from '@pulumi/random';

export interface SecretFromInput {
    /**
     * Name of the environment variable that will contain the secret value.
     *
     * Eg `MY_PASSWORD`
     */
    name: string;

    /**
     * Full ARN to a secrets manager or parameter store secret resource that contains your secret.
     */
    valueFromArn: pulumi.Input<string>;

    /**
     * The source of the secret, either `parameter-store` or `secrets-manager`.
     */
    source: 'parameter-store' | 'secrets-manager';

    /**
     * When using secrets manager, you can optionally provide a JSON key to include only a specific JSON property from
     * that secret.
     */
    key?: string;
}

export interface FargateServiceArgs {
    /**
     * ARN of an ALB listener to use for this service. A rule will be created to route relevant requests to the service
     *
     * Eg `arn:aws:elasticloadbalancing:<AWS_REGION>:<ACCOUNT_ID>:listener/app/name-of-alb/24cc901288efd990/eacc674b53cedc2d`
     */
    albListenerArn: pulumi.Input<string>;

    /**
     * ID of a Security Group that contains the ALB that will be handling traffic for this service.
     *
     * Eg `sg-9879a8e7dacd`
     */
    albSecurityGroupId?: pulumi.Input<string>;

    /**
     * Name of the ECS cluster to create the service in.
     */
    clusterName: pulumi.Input<string>;

    /**
     * Name of the container image to deploy. If the image is on Docker Hub you can just supply the name and tag eg
     * `nginx:1.19`. If you are using another registry, you need to provide the hostname as well eg
     * `chu-docker-local.jfrog.io/my-app:v3.2.1`.
     *
     * Note that if your registry requires authentication to access you also need to provide an appropriate value for
     * `repositoryCredentialsArn`
     */
    containerImage: string;

    /**
     * Amount of CPU units to allocate to each task in your service where 512 is equal to half of a CPU core. A much
     * more in-depth explanation on how CPU and memory allocation works can be seen here:
     *
     * https://aws.amazon.com/blogs/containers/how-amazon-ecs-manages-cpu-and-memory-resources/
     *
     * Default: `256`
     */
    cpu?: number;

    /**
     * How long (in days) to retain container logs for.
     *
     * Default: 14
     */
    logRetention?: number;

    /**
     * Amount of memory (in MB) to allocate to each task in your service. A much more in-depth explanation on how CPU
     * and memory allocation works can be seen here:
     *
     * https://aws.amazon.com/blogs/containers/how-amazon-ecs-manages-cpu-and-memory-resources/
     *
     * Default: `512`
     */
    memory?: number;

    /**
     * Namespace used as a prefix for resource names.
     */
    namespace?: string;

    /**
     * Which port your service listens on.
     *
     * Eg `8080`
     */
    port: number;

    /**
     * ARN to a Secrets Manager secret containing the relevant repository credentials for the container(s) being
     * deployed in this service.
     *
     * https://docs.aws.amazon.com/AmazonECS/latest/developerguide/private-auth.html
     */
    repositoryCredentialsArn?: pulumi.Input<string>;

    /**
     * An array of Secrets Manager or Parameter Store ARNs to pass to the task as environment variables.
     */
    secrets?: SecretFromInput[];

    /**
     * An array of subnet IDs that the service should utilize. Must be subnets that are within the VPC provided in
     * `vpcId`. Ideally you should supply one subnet for each Availability Zone available in your region. The subnets
     * are assumed to be private subnets - the service will not be allocated a public IP and will need a route to a NAT
     * gateway in order to access the internet.
     *
     * Eg `[ "subnet-6e76bba91252cf919", "subnet-bbb9026a13a08b2ea" ]`
     */
    subnetIds: pulumi.Input<string[]>;

    /**
     * An IAM policy defining what AWS permissions you would like the container(s) in your service to have. Defaults to
     * having no permissions
     */
    taskPolicy?: aws.iam.PolicyDocument;

    /**
     * ID of the VPC the service should be provisioned in.
     *
     * Eg `vpc-1aa478ffc`
     */
    vpcId: pulumi.Input<string>;
}

export class FargateService extends pulumi.ComponentResource {
    readonly executionRole: aws.iam.Role;

    readonly logGroup: aws.cloudwatch.LogGroup;

    readonly securityGroup: aws.ec2.SecurityGroup;

    readonly service: aws.ecs.Service;

    readonly taskDefinition: aws.ecs.TaskDefinition;

    readonly taskRole: aws.iam.Role;

    constructor(name: string, args: FargateServiceArgs, opts?: pulumi.ComponentResourceOptions) {
        super('FargateService', name, args, opts);

        const defaults = {
            cpu: 256,
            logRetention: 14,
            memory: 512,
        };

        const {
            albListenerArn,
            albSecurityGroupId,
            clusterName,
            containerImage,
            cpu,
            logRetention,
            memory,
            namespace,
            port,
            repositoryCredentialsArn,
            secrets,
            subnetIds,
            taskPolicy,
            vpcId,
        } = { ...defaults, ...args };

        const prefix = namespace ?? `${name}-${pulumi.getStack()}`;
        const { name: region } = pulumi.output(aws.getRegion());

        // Everything from the pgweb container's stdout will be stored in this log group
        const logGroup = new aws.cloudwatch.LogGroup(
            `${prefix}-log-group`,
            {
                retentionInDays: logRetention,
            },
            { parent: this },
        );

        // A role that AWS assumes in order to *launch* the task (not the role that the task itself assumes)
        const executionRole = new aws.iam.Role(
            `${prefix}-execution-role`,
            {
                description: `Allows the AWS ECS service to create and manage the ${prefix} service`,
                assumeRolePolicy: {
                    Version: '2012-10-17',
                    Statement: [
                        {
                            Effect: 'Allow',
                            Principal: { Service: 'ecs-tasks.amazonaws.com' },
                            Action: 'sts:AssumeRole',
                        },
                    ],
                },
            },
            { parent: this },
        );

        // AWS-managed policy giving the above role some basic permissions it needs
        const executionPolicyBasic = new aws.iam.RolePolicyAttachment(
            'basic-ecs-policy',
            {
                policyArn: 'arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy',
                role: executionRole,
            },
            { parent: executionRole },
        );

        // Policy allowing ECS to write to the container's log group
        const executionPolicyLogs = new aws.iam.RolePolicy(
            'logs-policy',
            {
                role: executionRole,
                policy: {
                    Version: '2012-10-17',
                    Statement: [
                        {
                            Effect: 'Allow',
                            Action: ['logs:CreateLogStream', 'logs:PutLogEvents'],
                            Resource: pulumi.interpolate`${logGroup.arn}:*`,
                        },
                    ],
                },
            },
            { parent: executionRole },
        );

        // If secrets have been supplied, we also need to create policies allowing access to them
        if (secrets) {
            const smSecrets = secrets.filter((s) => s.source === 'secrets-manager').map((s) => s.valueFromArn);
            const psSecrets = secrets.filter((s) => s.source === 'parameter-store').map((s) => s.valueFromArn);

            if (smSecrets.length > 0) {
                // Since its possible for multiples of the secrets manager secrets to be used with different keys, we
                // need to generate a list of unique resource ARNs
                const uniqueArns = pulumi.all(smSecrets).apply((arns) => [...new Set(arns)]);

                const secretsManagerPolicy = new aws.iam.RolePolicy(
                    'secrets-manager-policy',
                    {
                        role: executionRole,
                        policy: {
                            Version: '2012-10-17',
                            Statement: [
                                {
                                    Effect: 'Allow',
                                    Action: 'secretsmanager:GetSecretValue',
                                    Resource: uniqueArns,
                                },
                            ],
                        },
                    },
                    { parent: executionRole },
                );
            }

            if (psSecrets.length > 0) {
                const parameterStorePolicy = new aws.iam.RolePolicy(
                    'parameter-store-policy',
                    {
                        role: executionRole,
                        policy: {
                            Version: '2012-10-17',
                            Statement: [
                                {
                                    Effect: 'Allow',
                                    Action: 'ssm:GetParameter*',
                                    Resource: psSecrets,
                                },
                            ],
                        },
                    },
                    { parent: executionRole },
                );
            }
        }

        // We'll also need a policy allowing access to the supplied repository credentials (if supplied)
        if (repositoryCredentialsArn) {
            const repositorySecretsPolicy = new aws.iam.RolePolicy(
                'container-repo-creds-policy',
                {
                    role: executionRole,
                    name: 'repo-secret-policy',
                    policy: {
                        Version: '2012-10-17',
                        Statement: [
                            {
                                Effect: 'Allow',
                                Action: 'secretsmanager:GetSecretValue',
                                Resource: repositoryCredentialsArn,
                            },
                        ],
                    },
                },
                { parent: executionRole },
            );
        }

        // The role the actual task itself will assume
        const taskRole = new aws.iam.Role(
            `${prefix}-task-role`,
            {
                assumeRolePolicy: {
                    Version: '2012-10-17',
                    Statement: [
                        {
                            Effect: 'Allow',
                            Principal: {
                                Service: 'ecs-tasks.amazonaws.com',
                            },
                            Action: 'sts:AssumeRole',
                        },
                    ],
                },
            },
            { parent: this },
        );

        if (taskPolicy) {
            const taskRolePolicy = new aws.iam.RolePolicy(
                `${prefix}-role-policy`,
                {
                    role: taskRole,
                    policy: taskPolicy,
                },
                { parent: taskRole },
            );
        }

        const securityGroup = new aws.ec2.SecurityGroup(
            `${prefix}-service-sg`,
            {
                vpcId,
                description: `Controls access to the ${prefix} service`,
            },
            { parent: this },
        );

        const egressRule = new aws.ec2.SecurityGroupRule(
            'egress-rule',
            {
                type: 'egress',
                securityGroupId: securityGroup.id,
                protocol: '-1',
                fromPort: 0,
                toPort: 0,
                cidrBlocks: ['0.0.0.0/0'],
            },
            { parent: securityGroup },
        );

        let albConfig: aws.types.input.ecs.ServiceLoadBalancer | undefined;
        let listenerRule: aws.lb.ListenerRule | undefined;

        if (albSecurityGroupId) {
            const ingressFromAlb = new aws.ec2.SecurityGroupRule(
                'ingress-from-alb-rule',
                {
                    type: 'ingress',
                    securityGroupId: securityGroup.id,
                    protocol: 'TCP',
                    fromPort: port,
                    toPort: port,
                    sourceSecurityGroupId: albSecurityGroupId,
                },
                { parent: securityGroup },
            );

            const targetGroup = new aws.lb.TargetGroup(
                `${prefix}-tg`,
                {
                    deregistrationDelay: 10,
                    vpcId: args.vpcId,
                    port,
                    targetType: 'ip',
                    protocol: 'HTTP',
                    slowStart: 30,
                    healthCheck: {
                        path: '/',
                        healthyThreshold: 4,
                        unhealthyThreshold: 2,
                        interval: 15,
                        timeout: 10,
                    },
                },
                { parent: this },
            );

            listenerRule = new aws.lb.ListenerRule(
                `${prefix}-listener-rule`,
                {
                    listenerArn: albListenerArn,
                    conditions: [{ pathPattern: { values: ['/*'] } }],
                    actions: [{ type: 'forward', targetGroupArn: targetGroup.arn }],
                },
                { parent: this, deleteBeforeReplace: true },
            );

            albConfig = { containerPort: port, targetGroupArn: targetGroup.arn, containerName: 'container' };
        }

        const randomId = new random.RandomId(
            'task-definition-family-id',
            {
                byteLength: 4,
            },
            { parent: this },
        );

        const taskDefinition = new aws.ecs.TaskDefinition(
            `${prefix}-task-definition`,
            {
                family: pulumi.interpolate`${prefix}-${randomId.hex}`,
                executionRoleArn: executionRole.arn,
                taskRoleArn: taskRole.arn,
                networkMode: 'awsvpc',
                requiresCompatibilities: ['FARGATE'],
                cpu: cpu.toString(),
                memory: memory.toString(),
                containerDefinitions: pulumi.all([logGroup.name, region]).apply(([logGroupName, logRegion]) =>
                    JSON.stringify([
                        {
                            name: 'container',
                            image: containerImage,
                            portMappings: [{ containerPort: port }],
                            logConfiguration: {
                                logDriver: 'awslogs',
                                options: {
                                    'awslogs-group': logGroupName,
                                    'awslogs-region': logRegion,
                                    'awslogs-stream-prefix': 'container',
                                },
                            },
                        },
                    ]),
                ),
            },
            { parent: this },
        );

        const service = new aws.ecs.Service(
            `${prefix}-service`,
            {
                cluster: clusterName,
                launchType: 'FARGATE',
                desiredCount: 1,
                deploymentMinimumHealthyPercent: 100,
                loadBalancers: albConfig && [albConfig],
                taskDefinition: taskDefinition.arn,
                waitForSteadyState: true,
                networkConfiguration: {
                    securityGroups: [securityGroup.id],
                    subnets: subnetIds,
                },
            },
            {
                parent: this,
                // The service needs to depend on the listener rule since AWS will not add a service to a target group
                // until the target group is associated with a listener which doesn't occur until the listener rule is
                // created. This lets Pulumi know of this implicit dependency so it won't try (and fail) to create the
                // service
                dependsOn: listenerRule,
            },
        );

        this.executionRole = executionRole;
        this.logGroup = logGroup;
        this.securityGroup = securityGroup;
        this.service = service;
        this.taskDefinition = taskDefinition;
        this.taskRole = taskRole;
    }
}

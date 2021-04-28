import * as pulumi from '@pulumi/pulumi';
import * as aws from '@pulumi/aws';
import * as random from '@pulumi/random';
import { FargateServiceArgs, FargateServiceDefaults, FargateServiceArgsWithDefaults, SecretFromInput } from './types';
import { validCpuMemoryCombinations } from './constants';

export default class FargateService extends pulumi.ComponentResource {
    readonly executionRole: aws.iam.Role;

    readonly securityGroup: aws.ec2.SecurityGroup;

    readonly service: aws.ecs.Service;

    readonly taskDefinition: aws.ecs.TaskDefinition;

    readonly taskRole: aws.iam.Role;

    constructor(name: string, args: FargateServiceArgs, opts?: pulumi.ComponentResourceOptions) {
        super('FargateService', name, args, opts);

        const {
            albConfig,
            clusterName,
            containers,
            cpu,
            memory,
            namespace,
            repositoryCredentialsArn,
            subnetIds,
            taskPolicy,
            vpcId,
        } = this.validateArgs(args, {
            cpu: 256,
            memory: 512,
            namespace: `${name}-${pulumi.getStack()}`,
        });

        const { name: region } = pulumi.output(aws.getRegion());
        const { accountId } = pulumi.output(aws.getCallerIdentity());

        // A role that AWS assumes in order to *launch* the task (not the role that the task itself assumes)
        const executionRole = new aws.iam.Role(
            `${namespace}-execution-role`,
            {
                description: `Allows the AWS ECS service to create and manage the ${namespace} service`,
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

        const logGroupArns = containers.reduce((arns, { logGroupName }) => {
            if (logGroupName) {
                arns.push(pulumi.interpolate`arn:aws:logs:${region}:${accountId}:log-group:/${logGroupName}:*`);
            }
            return arns;
        }, [] as pulumi.Input<string>[]);

        if (logGroupArns.length > 0) {
            // Policy allowing ECS to write to the all relevant log groups
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
                                Resource: logGroupArns,
                            },
                        ],
                    },
                },
                { parent: executionRole },
            );
        }

        const allSecrets = containers.reduce(
            (secrets, container) => (container.secrets ? [...secrets, ...container.secrets] : secrets),
            [] as SecretFromInput[],
        );

        // If secrets have been supplied, create policies allowing access to them
        if (allSecrets) {
            const smSecrets = allSecrets.filter((s) => s.source === 'secrets-manager').map((s) => s.valueFromArn);
            const psSecrets = allSecrets.filter((s) => s.source === 'parameter-store').map((s) => s.valueFromArn);

            if (smSecrets.length > 0) {
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
                const uniqueArns = pulumi.all(psSecrets).apply((arns) => [...new Set(arns)]);

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
                                    Resource: uniqueArns,
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
            `${namespace}-task-role`,
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
                `${namespace}-role-policy`,
                {
                    role: taskRole,
                    policy: taskPolicy,
                },
                { parent: taskRole },
            );
        }

        const securityGroup = new aws.ec2.SecurityGroup(
            `${namespace}-service-sg`,
            {
                vpcId,
                description: `Controls access to the ${namespace} service`,
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

        const randomId = new random.RandomId(
            'task-definition-family-id',
            {
                byteLength: 4,
            },
            { parent: this },
        );

        const taskDefinition = new aws.ecs.TaskDefinition(
            `${namespace}-task-definition`,
            {
                family: pulumi.interpolate`${namespace}-${randomId.hex}`,
                executionRoleArn: executionRole.arn,
                taskRoleArn: taskRole.arn,
                networkMode: 'awsvpc',
                requiresCompatibilities: ['FARGATE'],
                cpu: cpu.toString(),
                memory: memory.toString(),
                containerDefinitions: pulumi.output(containers).apply((defs) => JSON.stringify(defs)),
            },
            { parent: this },
        );

        let service: aws.ecs.Service;

        if (albConfig) {
            const ingressFromAlb = new aws.ec2.SecurityGroupRule(
                'ingress-from-alb-rule',
                {
                    type: 'ingress',
                    securityGroupId: securityGroup.id,
                    protocol: 'TCP',
                    fromPort: albConfig.portMapping.containerPort,
                    toPort: albConfig.portMapping.containerPort,
                    sourceSecurityGroupId: albConfig.securityGroupId,
                },
                { parent: securityGroup },
            );

            const targetGroup = new aws.lb.TargetGroup(
                `${namespace}-tg`,
                {
                    deregistrationDelay: 10,
                    vpcId: args.vpcId,
                    targetType: 'ip',
                    protocol: 'HTTP',
                    slowStart: 30,
                    healthCheck: albConfig.healthCheckConfig,
                },
                { parent: this },
            );

            const listenerRule = new aws.lb.ListenerRule(
                `${namespace}-listener-rule`,
                {
                    listenerArn: albConfig.listenerArn,
                    conditions: [{ pathPattern: { values: ['/*'] } }],
                    actions: [{ type: 'forward', targetGroupArn: targetGroup.arn }],
                },
                { parent: this, deleteBeforeReplace: true },
            );

            service = new aws.ecs.Service(
                `${namespace}-service`,
                {
                    cluster: clusterName,
                    launchType: 'FARGATE',
                    desiredCount: 1,
                    deploymentMinimumHealthyPercent: 100,
                    loadBalancers: [{ ...albConfig.portMapping, targetGroupArn: targetGroup.arn }],
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
        } else {
            service = new aws.ecs.Service(
                `${namespace}-service`,
                {
                    cluster: clusterName,
                    launchType: 'FARGATE',
                    desiredCount: 1,
                    deploymentMinimumHealthyPercent: 100,
                    taskDefinition: taskDefinition.arn,
                    waitForSteadyState: true,
                    networkConfiguration: {
                        securityGroups: [securityGroup.id],
                        subnets: subnetIds,
                    },
                },
                {
                    parent: this,
                },
            );
        }

        this.executionRole = executionRole;
        this.securityGroup = securityGroup;
        this.service = service;
        this.taskDefinition = taskDefinition;
        this.taskRole = taskRole;

        // https://www.pulumi.com/docs/intro/concepts/resources/#registering-component-outputs
        this.registerOutputs();
    }

    // eslint-disable-next-line class-methods-use-this
    private validateArgs(input: FargateServiceArgs, defaults: FargateServiceDefaults): FargateServiceArgsWithDefaults {
        const errors: string[] = [];
        const args = { ...defaults, ...input };

        // CPU and Memory validation
        if (!validCpuMemoryCombinations.includes([args.cpu, args.memory])) {
            errors.push(
                `CPU: ${args.cpu} and Memory: ${args.memory} is an unsupported combination, see https://docs.aws.amazon.com/AmazonECS/latest/developerguide/AWS_Fargate.html for valid combinations`,
            );
        }

        const sumOfCpuAllocation = args.containers.reduce((sum, c) => (c.cpu ? sum + c.cpu : sum), 0);

        if (sumOfCpuAllocation > args.cpu) {
            errors.push(
                `Sum of CPU allocation for all containers ${sumOfCpuAllocation} exceeds the CPU limit set for the task ${args.cpu}`,
            );
        }

        const sumOfMemoryAllocation = args.containers.reduce((sum, c) => (c.memory ? sum + c.memory : sum), 0);

        if (sumOfMemoryAllocation > args.memory) {
            errors.push(
                `Sum of memory allocation for all containers ${sumOfMemoryAllocation} exceeds the memory limit set for the task ${args.memory}`,
            );
        }

        // Namespace - must be <= 22 characters. Anything longer means the target group physical name will exceed the 32
        // character limit defined by AWS.
        // 22 + random-7-letter-suffix + '-tg' = 32
        if (args.namespace.length > 22) {
            errors.push(
                `Namespace cannot be longer than 22 characters. "${args.namespace}" is ${args.namespace.length} characters`,
            );
        }

        if (errors.length > 0) {
            const errStr = errors.reduce((str, err) => `${str}\t- ${err}\n`, '');

            throw new pulumi.ResourceError(`Invalid FargateService args:\n${errStr}`, this);
        }

        return args;
    }
}

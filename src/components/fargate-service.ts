import * as pulumi from '@pulumi/pulumi';
import * as aws from '@pulumi/aws';
import * as random from '@pulumi/random';
import {
    FargateServiceArgs,
    FargateServiceDefaults,
    FargateServiceArgsWithDefaults,
    SecretFromInput,
    FargateContainerDefinition,
} from './types';
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

        // We'll also need a policy allowing access to any supplied repository credentials
        const repositoryCredentialArns = containers.reduce((repoCreds, { repositoryCredentials }) => {
            if (repositoryCredentials) {
                repoCreds.push(repositoryCredentials.credentialsParameter);
            }
            return repoCreds;
        }, [] as string[]);

        if (repositoryCredentialArns.length > 0) {
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
                                Resource: repositoryCredentialArns,
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
                containerDefinitions: this.generateAwsContainerDefinitions(containers).apply((defs) =>
                    JSON.stringify(defs),
                ),
            },
            { parent: this },
        );

        const loadBalancers: aws.types.input.ecs.ServiceLoadBalancer[] = [];
        const serviceOpts: pulumi.ResourceOptions = {};

        if (albConfig) {
            const {
                healthCheckConfig,
                listenerArn,
                ruleActions,
                rulePriority,
                portMapping,
                securityGroupId,
            } = albConfig;

            const ingressFromAlb = new aws.ec2.SecurityGroupRule(
                'ingress-from-alb-rule',
                {
                    type: 'ingress',
                    securityGroupId: securityGroup.id,
                    protocol: 'TCP',
                    fromPort: portMapping.containerPort,
                    toPort: portMapping.containerPort,
                    sourceSecurityGroupId: securityGroupId,
                },
                { parent: securityGroup },
            );

            const targetGroup = new aws.lb.TargetGroup(
                `${namespace}-tg`,
                {
                    deregistrationDelay: 10,
                    vpcId: args.vpcId,
                    targetType: 'ip',
                    port: portMapping.containerPort,
                    protocol: 'HTTP',
                    slowStart: 30,
                    healthCheck: healthCheckConfig,
                },
                { parent: this },
            );

            const actions: aws.types.input.lb.ListenerRuleAction[] = [];

            if (ruleActions) ruleActions.forEach((action, index) => actions.push({ order: index + 1, ...action }));

            actions.push({
                order: ruleActions?.length ? ruleActions.length + 1 : 1,
                type: 'forward',
                targetGroupArn: targetGroup.arn,
            });

            const listenerRule = new aws.lb.ListenerRule(
                `${namespace}-listener-rule`,
                {
                    priority: rulePriority,
                    listenerArn,
                    conditions: [{ pathPattern: { values: ['/*'] } }],
                    actions,
                },
                { parent: this, deleteBeforeReplace: true },
            );

            loadBalancers.push({ ...portMapping, targetGroupArn: targetGroup.arn });

            // The service needs to depend on the listener rule since AWS will not add a service to a target group until
            // the target group is associated with a listener which doesn't occur until the listener rule is created.
            // This lets Pulumi know of this implicit dependency so it won't try (and fail) to create the service
            serviceOpts.dependsOn = listenerRule;
        }

        const service = new aws.ecs.Service(
            `${namespace}-service`,
            {
                loadBalancers,
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
                ...serviceOpts,
            },
        );

        this.executionRole = executionRole;
        this.securityGroup = securityGroup;
        this.service = service;
        this.taskDefinition = taskDefinition;
        this.taskRole = taskRole;

        // https://www.pulumi.com/docs/intro/concepts/resources/#registering-component-outputs
        this.registerOutputs();
    }

    private generateAwsContainerDefinitions(input: FargateContainerDefinition[]) {
        return pulumi.output(input.map((def) => this.generateAwsContainerDefinition(def)));
    }

    /**
     * Converts the type FargateContainerDefinition (defined by this code) into a aws.ecs.ContainerDefinition
     */
    private generateAwsContainerDefinition(input: FargateContainerDefinition) {
        const secretsResult = input.secrets?.map(({ name, valueFromArn }) => ({ name, valueFrom: valueFromArn }));
        const logConfigurationResult = input.logGroupName
            ? {
                  logDriver: 'awslogs',
                  options: {
                      'awslogs-region': aws.config.requireRegion().toString(),
                      'awslogs-group': input.logGroupName,
                      'awslogs-stream-prefix': input.name,
                  },
              }
            : undefined;

        return pulumi
            .all([pulumi.output(input), secretsResult, logConfigurationResult])
            .apply(([args, secrets, logConfiguration]) => ({
                command: args.command,
                cpu: args.cpu,
                dependsOn: args.dependsOn,
                disableNetworking: args.disableNetworking,
                dnsSearchDomains: args.dnsSearchDomains,
                dnsServers: args.dnsServers,
                dockerLabels: args.dockerLabels,
                entryPoint: args.entryPoint,
                environment: args.environment,
                essential: args.essential,
                extraHosts: args.extraHosts,
                firelensConfiguration: args.firelensConfiguration,
                healthCheck: args.healthCheck,
                image: args.image,
                interactive: args.interactive,
                linuxParameters: args.linuxParameters,
                logConfiguration,
                memory: args.memory,
                memoryReservation: args.memoryReservation,
                mountPoints: args.mountPoints,
                name: args.name,
                portMappings: args.portMappings,
                privileged: args.privileged,
                pseudoTerminal: args.pseudoTerminal,
                readonlyRootFilesystem: args.readonlyRootFilesystem,
                repositoryCredentials: args.repositoryCredentials,
                resourceRequirements: args.resourceRequirements,
                secrets,
                startTimeout: args.startTimeout,
                stopTimeout: args.stopTimeout,
                systemControls: args.systemControls,
                ulimits: args.ulimits,
                user: args.user,
                volumesFrom: args.volumesFrom,
                workingDirectory: args.workingDirectory,
            }));
    }

    private validateArgs(input: FargateServiceArgs, defaults: FargateServiceDefaults): FargateServiceArgsWithDefaults {
        const errors: string[] = [];
        const args = { ...defaults, ...input };

        // CPU and Memory validation
        if (!validCpuMemoryCombinations.includes(`${args.cpu}x${args.memory}`)) {
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

        const priority = args.albConfig?.rulePriority;

        // Listener rule priority must be between 1 and 50,000
        if (priority && (priority < 1 || priority > 50_000)) {
            errors.push(`Listener rule priority must be between 1 and 50,000`);
        }

        if (errors.length > 0) {
            const errStr = errors.reduce((str, err) => `${str}\t- ${err}\n`, '');

            throw new pulumi.ResourceError(`Invalid FargateService args:\n${errStr}`, this);
        }

        return args;
    }
}

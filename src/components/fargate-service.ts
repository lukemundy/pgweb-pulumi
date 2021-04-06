import * as pulumi from '@pulumi/pulumi';
import * as aws from '@pulumi/aws';

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
     * ID of a Security Group that contains the ALB that will be handling traffic for this service.
     *
     * Eg `sg-9879a8e7dacd`
     */
    albSecurityGroupId: pulumi.Input<string>;

    /**
     * Name of the ECS cluster to create the service in.
     */
    clusterName: pulumi.Input<string>;

    /**
     * How long (in days) to retain container logs for.
     */
    logRetention?: number;

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

    readonly taskRole: aws.iam.Role;

    constructor(name: string, args: FargateServiceArgs, opts?: pulumi.ComponentResourceOptions) {
        super('FargateService', name, args, opts);

        const {
            albSecurityGroupId,
            clusterName,
            logRetention,
            namespace,
            port,
            repositoryCredentialsArn,
            secrets,
            taskPolicy,
            vpcId,
        } = args;
        const prefix = namespace ?? `${name}-${pulumi.getStack()}`;

        // Everything from the pgweb container's stdout will be stored in this log group
        const logGroup = new aws.cloudwatch.LogGroup(
            `${prefix}-log-group`,
            {
                retentionInDays: logRetention ?? 14,
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
            `${prefix}-sg`,
            {
                vpcId,
                description: `Controls access to the ${prefix} service`,
            },
            { parent: this },
        );

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

        this.executionRole = executionRole;
        this.logGroup = logGroup;
        this.securityGroup = securityGroup;
        this.taskRole = taskRole;
    }
}

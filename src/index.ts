import * as pulumi from '@pulumi/pulumi';
import * as aws from '@pulumi/aws';
import { FargateService } from './components/fargate-service';

const cfg = new pulumi.Config();
const prefix = `pgweb-${pulumi.getStack()}`;

const vpcId = cfg.require('vpcId');
const subnetIds = cfg.requireObject<string[]>('subnetIds');

const cluster = new aws.ecs.Cluster(`${prefix}-cluster`);

const albSecurityGroup = new aws.ec2.SecurityGroup(`${prefix}-alb-sg`, {
    vpcId,
    description: `Controls access to the ${prefix} load balancer`,
});

const albIngressRule = new aws.ec2.SecurityGroupRule(
    'ingress-rule',
    {
        type: 'ingress',
        securityGroupId: albSecurityGroup.id,
        protocol: 'TCP',
        fromPort: 80,
        toPort: 80,
        cidrBlocks: ['0.0.0.0/0'],
    },
    { parent: albSecurityGroup },
);

const alb = new aws.lb.LoadBalancer(`${prefix}-alb`, {
    securityGroups: [albSecurityGroup.id],
    subnets: subnetIds,
});

const listener = new aws.lb.Listener(
    'http-listener',
    {
        loadBalancerArn: alb.arn,
        port: 80,
        defaultActions: [
            {
                type: 'fixed-response',
                fixedResponse: {
                    statusCode: '404',
                    contentType: 'text/plain',
                    messageBody: 'Not Found',
                },
            },
        ],
    },
    { parent: alb },
);

const service = new FargateService('pgweb-service', {
    albSecurityGroupId: albSecurityGroup.id,
    albListenerArn: listener.arn,
    clusterName: cluster.name,
    containerImage: 'sosedoff/pgweb',
    namespace: prefix,
    port: 8081,
    subnetIds,
    vpcId,
});

const albEgressToServiceRule = new aws.ec2.SecurityGroupRule(
    'egress-to-service-rule',
    {
        type: 'egress',
        securityGroupId: albSecurityGroup.id,
        protocol: 'TCP',
        fromPort: 8081,
        toPort: 8081,
        sourceSecurityGroupId: service.securityGroup.id,
    },
    { parent: albSecurityGroup },
);

export const logGroupName = service.logGroup.name;
export const serviceSecurityGroupId = service.securityGroup.id;
export const taskDefinitionArn = service.taskDefinition.arn;
export const taskRoleArn = service.taskRole.arn;

export const albDnsName = alb.dnsName;
export const albSecurityGroupId = albSecurityGroup.id;

import * as pulumi from '@pulumi/pulumi';
import * as aws from '@pulumi/aws';
import FargateService from './components/fargate-service';
import { certificate } from './certificate';

const cfg = new pulumi.Config();
const prefix = `pgweb-${pulumi.getStack()}`;

const vpcId = cfg.require('vpcId');
const albSubnetIds = cfg.requireObject<string[]>('albSubnetIds');
const pgwebSubnetIds = cfg.requireObject<string[]>('pgwebSubnetIds');
const zoneId = cfg.require('hostedZoneId');

const cluster = new aws.ecs.Cluster(`${prefix}-cluster`);

const albSecurityGroup = new aws.ec2.SecurityGroup(`${prefix}-alb-sg`, {
    vpcId,
    description: `Controls access to the ${prefix} load balancer`,
});

const albHttpIngressRule = new aws.ec2.SecurityGroupRule(
    'http-ingress-rule',
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

const albHttpsIngressRule = new aws.ec2.SecurityGroupRule(
    'https-ingress-rule',
    {
        type: 'ingress',
        securityGroupId: albSecurityGroup.id,
        protocol: 'TCP',
        fromPort: 443,
        toPort: 443,
        cidrBlocks: ['0.0.0.0/0'],
    },
    { parent: albSecurityGroup },
);

const alb = new aws.lb.LoadBalancer(`${prefix}-alb`, {
    securityGroups: [albSecurityGroup.id],
    subnets: albSubnetIds,
    dropInvalidHeaderFields: true,
});

const httpListener = new aws.lb.Listener(
    'http-listener',
    {
        loadBalancerArn: alb.arn,
        port: 80,
        defaultActions: [
            {
                type: 'redirect',
                redirect: { protocol: 'HTTPS', statusCode: 'HTTP_301', port: '443' },
            },
        ],
    },
    { parent: alb },
);

const httpsListener = new aws.lb.Listener(
    'https-listener',
    {
        loadBalancerArn: alb.arn,
        port: 443,
        certificateArn: certificate.arn,
        protocol: 'HTTPS',
        sslPolicy: 'ELBSecurityPolicy-FS-1-2-Res-2020-10',
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
    albConfig: {
        listenerArn: httpsListener.arn,
        securityGroupId: albSecurityGroup.id,
        portMapping: { containerName: 'pgweb', containerPort: 8081 },
    },
    clusterName: cluster.name,
    containers: [
        {
            name: 'pgweb',
            image: 'sosedoff/pgweb',
            logGroupName: 'asd',
            portMappings: [{ containerPort: 8081, protocol: 'tcp' }],
        },
    ],
    namespace: prefix,
    subnetIds: pgwebSubnetIds,
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

const pgwebDns = new aws.route53.Record(`${prefix}-dns-record`, {
    zoneId,
    name: `${prefix}`,
    type: 'CNAME',
    records: [alb.dnsName],
    ttl: 300,
});

export const serviceSecurityGroupId = service.securityGroup.id;
export const taskDefinitionArn = service.taskDefinition.arn;
export const taskRoleArn = service.taskRole.arn;

export const albDnsName = alb.dnsName;
export const albSecurityGroupId = albSecurityGroup.id;
export const certificateArn = certificate.arn;
export const pgwebUrl = pulumi.interpolate`https://${pgwebDns.fqdn}`;

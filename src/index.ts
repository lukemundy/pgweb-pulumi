import * as pulumi from '@pulumi/pulumi';
import * as aws from '@pulumi/aws';
import FargateService from './components/fargate-service';
import { certificate } from './certificate';
import { app, server } from './okta';

const cfg = new pulumi.Config();
const prefix = `pgweb-${pulumi.getStack()}`;

const vpcId = cfg.require('vpcId');
const albSubnetIds = cfg.requireObject<string[]>('albSubnetIds');
const pgwebSubnetIds = cfg.requireObject<string[]>('pgwebSubnetIds');
const zoneId = cfg.require('hostedZoneId');
const albLogBucket = cfg.require('albLogBucket');

// OIDC settings
const { clientId, clientSecret } = app;
const { issuer } = server;
const authorizationEndpoint = pulumi.interpolate`${issuer}/v1/authorize`;
const tokenEndpoint = pulumi.interpolate`${issuer}/v1/token`;
const userInfoEndpoint = pulumi.interpolate`${issuer}/v1/userinfo`;

const cluster = new aws.ecs.Cluster(`${prefix}-cluster`);

const albSecurityGroup = new aws.ec2.SecurityGroup(`${prefix}-alb-sg`, {
    vpcId,
    description: `Controls access to the ${prefix} load balancer`,
});

// This is needed so the ALB can communicate with the Okta IDP and verify tokens
const albEgressRule = new aws.ec2.SecurityGroupRule(
    'https-engress-rule',
    {
        type: 'egress',
        securityGroupId: albSecurityGroup.id,
        protocol: 'TCP',
        fromPort: 443,
        toPort: 443,
        cidrBlocks: ['0.0.0.0/0'],
    },
    { parent: albSecurityGroup },
);

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
    accessLogs: albLogBucket
        ? {
              enabled: true,
              bucket: albLogBucket,
              prefix: cfg.get('albLogBucketPrefix'),
          }
        : undefined,
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

// Create a listener rule action that performs OIDC auth
const authAction = {
    type: 'authenticate-oidc',
    authenticateOidc: {
        onUnauthenticatedRequest: 'authenticate',
        clientId,
        clientSecret,
        authorizationEndpoint,
        tokenEndpoint,
        userInfoEndpoint,
        issuer,
        sessionTimeout: 14_400, // 4 hours
    },
};

const service = new FargateService('pgweb-service', {
    albConfig: {
        listenerArn: httpsListener.arn,
        securityGroupId: albSecurityGroup.id,
        ruleActions: [authAction],
        portMapping: { containerName: 'pgweb', containerPort: 8081 },
        healthCheckConfig: {
            enabled: true,
            path: '/',
        },
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

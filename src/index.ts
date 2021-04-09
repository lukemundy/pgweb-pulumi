import * as pulumi from '@pulumi/pulumi';
import * as aws from '@pulumi/aws';
import { FargateService } from './components/fargate-service';

const cfg = new pulumi.Config();
const prefix = `pgweb-${pulumi.getStack()}`;

const vpcId = cfg.require('vpcId');

const albSecurityGroup = new aws.ec2.SecurityGroup(`${prefix}-alb-sg`, {
    vpcId,
    description: `Controls access to the ${prefix} load balancer`,
});

const service = new FargateService('pgweb-service', {
    albSecurityGroupId: albSecurityGroup.id,
    clusterName: 'my-cluster',
    containerImage: 'sosedoff/pgweb',
    namespace: prefix,
    port: 8081,
    vpcId,
});

export const executionRoleArn = service.executionRole.arn;
export const logGroupName = service.logGroup.name;
export const serviceSecurityGroupId = service.securityGroup.id;
export const taskDefinitionArn = service.taskDefinition.arn;
export const taskRoleArn = service.taskRole.arn;

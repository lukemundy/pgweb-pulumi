import * as pulumi from '@pulumi/pulumi';
import { FargateService } from './components/fargate-service';

const cfg = new pulumi.Config();
const prefix = `pgweb-${pulumi.getStack()}`;

const service = new FargateService('pgweb-service', {
    albSecurityGroupId: 'sg-abcdef12345678',
    clusterName: 'my-cluster',
    namespace: prefix,
    port: 8080,
    vpcId: 'vpc-12345678abcdef',
});

export const executionRoleArn = service.executionRole.arn;
export const logGroupName = service.logGroup.name;
export const serviceSecurityGroupId = service.securityGroup.id;
export const taskRoleArn = service.taskRole.arn;

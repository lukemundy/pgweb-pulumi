import * as pulumi from '@pulumi/pulumi';
import { FargateService } from './components/fargate-service';

const cfg = new pulumi.Config();

const service = new FargateService('pgweb-service', {
    clusterName: 'my-cluster',
    namespace: 'pgweb',
});

export const executionRoleArn = service.executionRole.arn;
export const logGroupName = service.logGroup.name;

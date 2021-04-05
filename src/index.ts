import * as pulumi from '@pulumi/pulumi';
import * as aws from '@pulumi/aws';

const cfg = new pulumi.Config();

const bucket = new aws.s3.Bucket('my-bucket');

export const bucketName = bucket.id;
export const bucketArn = bucket.arn;

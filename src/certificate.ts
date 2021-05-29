import * as pulumi from '@pulumi/pulumi';
import * as aws from '@pulumi/aws';

const cfg = new pulumi.Config();
const prefix = `pgweb-${pulumi.getStack()}`;

const zoneId = cfg.require('hostedZoneId');

interface DomainValidationRecord {
    name: string;
    value: string;
    type: string;
}

function getDomainValidationRecords(cert: aws.acm.Certificate): pulumi.Output<DomainValidationRecord[]> {
    return cert.domainValidationOptions.apply((dvos) =>
        dvos.map(({ resourceRecordName: name, resourceRecordType: type, resourceRecordValue: value }) => ({
            name,
            type,
            value,
        })),
    );
}

const domain = pulumi.output(aws.route53.getZone({ zoneId }));

export const certificate = new aws.acm.Certificate(`${prefix}-certificate`, {
    domainName: pulumi.interpolate`${prefix}.${domain.name}`,
    validationMethod: 'DNS',
    options: {
        certificateTransparencyLoggingPreference: 'ENABLED',
    },
    tags: {
        Name: `${prefix}-cert`,
    },
});

// In most cases its generally advised to not create resources within an apply() as it means the resource will not be
// visible during a preview. This is one case where I think it's acceptable. It's also the only way to provision and
// validate an ACM certificate during a `pulumi up` that I'm aware of
const validationRecords = getDomainValidationRecords(certificate).apply((records) =>
    records.map(
        ({ name, value, type }, i) =>
            new aws.route53.Record(
                `validation-record-${i + 1}`,
                {
                    name,
                    type,
                    zoneId,
                    ttl: 60,
                    records: [value],
                },
                { parent: certificate },
            ),
    ),
);

export const CertificateValidation = new aws.acm.CertificateValidation(
    `${prefix}-certificate-validation`,
    {
        certificateArn: certificate.arn,
        validationRecordFqdns: validationRecords.apply((records) => records.map(({ fqdn }) => fqdn)),
    },
    { parent: certificate },
);

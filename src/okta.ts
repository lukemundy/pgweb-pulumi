import * as pulumi from '@pulumi/pulumi';
import * as aws from '@pulumi/aws';
import * as okta from '@pulumi/okta';

const cfg = new pulumi.Config();

const zoneId = cfg.require('hostedZoneId');
const prefix = `pgweb-${pulumi.getStack()}`;
const domain = pulumi.output(aws.route53.getZone({ zoneId }));
const url = pulumi.interpolate`https://${prefix}.${domain.name}`;

const provider = new okta.Provider('okta-provider', {
    baseUrl: cfg.get('oktaBaseUrl') ?? 'okta.com',
    orgName: cfg.require('oktaOrgName'),
    apiToken: cfg.requireSecret('oktaApiToken'),
});

export const app = new okta.app.OAuth(
    'okta-app',
    {
        label: cfg.get('oktaAppName') ?? prefix,
        type: 'web',
        grantTypes: ['authorization_code', 'refresh_token'],
        redirectUris: [pulumi.interpolate`${url}/oauth2/idpresponse`],
        postLogoutRedirectUris: [url],
        loginUri: url,
        responseTypes: ['code'],
        consentMethod: 'TRUSTED',
    },
    {
        provider,
        // Since we're using a GroupAssignment below, we ignore changes to groups on this resource to avoid issues where
        // performing a `pulumi refresh` removes any group assignments on this resource
        ignoreChanges: ['groups'],
    },
);

export const server = new okta.auth.Server(
    'okta-server',
    {
        audiences: [url],
        description: `Server for ${prefix}`,
        issuerMode: 'ORG_URL',
        status: 'ACTIVE',
    },
    { provider },
);

const policy = new okta.auth.ServerPolicy(
    'okta-server-policy',
    {
        authServerId: server.id,
        description: `Auth Server Policy for ${prefix}`,
        status: 'ACTIVE',
        priority: 1,
        clientWhitelists: ['ALL_CLIENTS'],
    },
    { provider, parent: server },
);

const rule = new okta.auth.ServerPolicyRule(
    'okta-server-policy-rule',
    {
        authServerId: server.id,
        policyId: policy.id,
        status: 'ACTIVE',
        priority: 1,
        scopeWhitelists: ['*'],
        groupWhitelists: [pulumi.output(okta.group.getEveryoneGroup({}, { provider })).id],
        grantTypeWhitelists: ['authorization_code'],
    },
    { provider, parent: policy },
);

const userGroup = new okta.group.Group(
    'okta-users-group',
    {
        name: cfg.get('oktaGroupName') ?? prefix,
        description: `${prefix} access`,
    },
    {
        provider,
        // Members of this group will typically be managed by Okta Administrators rather than via Pulumi so we ensure we
        // ignore any changes to the members of this group so we don't accidentally remove everybody
        ignoreChanges: ['users'],
    },
);

const groupAssignment = new okta.app.GroupAssignment(
    'okta-app-users',
    {
        appId: app.id,
        groupId: userGroup.id,
    },
    { provider },
);

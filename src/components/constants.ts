/* eslint-disable import/prefer-default-export */
/**
 * Array of valid CPU and memory combinations
 *
 * https://docs.aws.amazon.com/AmazonECS/latest/developerguide/AWS_Fargate.html
 */
export const validCpuMemoryCombinations = [
    // 0.25 vCPU - 0.5 GB, 1 GB, 2 GB
    '256x512',
    '256x1024',
    '256x2048',
    // 0.5 vCPU - 1 GB, 2 GB, 3 GB, 4 GB
    '512x1024',
    '512x2048',
    '512x3072',
    '512x4096',
    // 1 vCPU - 2 GB, 3 GB, 4 GB, 5 GB, 6 GB, 7 GB, 8 GB
    '1024x2048',
    '1024x3072',
    '1024x4096',
    '1024x5120',
    '1024x6144',
    '1024x7168',
    '1024x8192',
    // 2 vCPU - Between 4 GB and 16 GB in 1-GB increments
    '2048x4096',
    '2048x5120',
    '2048x6144',
    '2048x7168',
    '2048x8192',
    '2048x9216',
    '2048x10240',
    '2048x11264',
    '2048x12288',
    '2048x13312',
    '2048x14336',
    '2048x15360',
    '2048x16384',
    // 4 vCPU - Between 8 GB and 30 GB in 1-GB increments
    '4096x8192',
    '4096x9216',
    '4096x10240',
    '4096x11264',
    '4096x12288',
    '4096x13312',
    '4096x14336',
    '4096x15360',
    '4096x16384',
    '4096x17408',
    '4096x18432',
    '4096x19456',
    '4096x20480',
    '4096x21504',
    '4096x22528',
    '4096x23552',
    '4096x24576',
    '4096x25600',
    '4096x26624',
    '4096x27648',
    '4096x28672',
    '4096x29696',
    '4096x30720',
];

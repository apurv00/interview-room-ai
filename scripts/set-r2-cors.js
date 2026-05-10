const { S3Client, PutBucketCorsCommand } = require('@aws-sdk/client-s3');

const accountId = process.env.R2_ACCOUNT_ID;
const accessKeyId = process.env.R2_ACCESS_KEY_ID;
const secretAccessKey = process.env.R2_SECRET_ACCESS_KEY;
const bucket = process.env.R2_BUCKET_NAME || 'interviewprepguru';

if (!accountId || !accessKeyId || !secretAccessKey) {
  console.error('Missing R2 env vars: R2_ACCOUNT_ID, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY');
  process.exit(1);
}

const client = new S3Client({
  region: 'auto',
  endpoint: `https://${accountId}.r2.cloudflarestorage.com`,
  credentials: { accessKeyId, secretAccessKey },
});

client.send(new PutBucketCorsCommand({
  Bucket: bucket,
  CORSConfiguration: {
    CORSRules: [
      {
        AllowedOrigins: ['https://www.interviewprep.guru', 'https://interviewprep.guru', 'http://localhost:3000'],
        AllowedMethods: ['GET', 'PUT', 'HEAD'],
        // Multipart browser uploads need ETag exposed after each PUT part.
        // Keep the request headers broad enough for presigned S3/R2 uploads
        // across browsers and future checksum-enabled multipart requests.
        AllowedHeaders: [
          'Content-Type',
          'Content-Length',
          'Content-MD5',
          'x-amz-content-sha256',
          'x-amz-date',
          'x-amz-security-token',
          'x-amz-user-agent',
          'x-amz-sdk-checksum-algorithm',
          'x-amz-checksum-crc32',
          'x-amz-checksum-crc32c',
          'x-amz-checksum-sha1',
          'x-amz-checksum-sha256',
        ],
        ExposeHeaders: ['ETag'],
        MaxAgeSeconds: 3600,
      },
    ],
  },
})).then(() => console.log('R2 CORS configured successfully for bucket:', bucket))
  .catch(err => console.error('Failed to set CORS:', err.message));

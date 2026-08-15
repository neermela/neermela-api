// Object storage abstraction (spec §21, §22, §92). Swap via STORAGE_PROVIDER.
// Large files are uploaded DIRECTLY to storage via a signed URL — never through the API server.
import { config } from '../../config/index.js';
import { mediaId } from '../../lib/ids.js';

const providers = {
  // Dev: returns a fake signed URL you can point at a local uploader/minio.
  mock: {
    async createUploadUrl({ contentType, folder = 'uploads' }) {
      const key = `${folder}/${mediaId()}`;
      return { mediaId: mediaId(), uploadUrl: `http://localhost:9000/${config.storage.gcsBucketPrivate}/${key}?mock-signed=1`, key, expiresIn: config.storage.signedUrlTtl };
    },
    publicUrl(key) { return `http://localhost:9000/${config.storage.gcsBucketPublic}/${key}`; },
  },
  // Google Cloud Storage: generate a V4 signed URL for resumable/PUT upload.
  gcs: {
    async createUploadUrl() {
      // const { Storage } = await import('@google-cloud/storage');
      // const storage = new Storage(); // uses STORAGE_SERVICE_ACCOUNT / workload identity
      // const bucket = storage.bucket(config.storage.gcsBucketPrivate);
      // const key = `uploads/${mediaId()}`;
      // const [url] = await bucket.file(key).getSignedUrl({ version: 'v4', action: 'write', expires: Date.now()+config.storage.signedUrlTtl*1000, contentType });
      // return { mediaId: mediaId(), uploadUrl: url, key, expiresIn: config.storage.signedUrlTtl };
      throw new Error('GCS adapter not configured. Add @google-cloud/storage and implement createUploadUrl().');
    },
    publicUrl(key) { return `https://storage.googleapis.com/${config.storage.gcsBucketPublic}/${key}`; },
  },
};
export const storage = {
  createUploadUrl(args) { return (providers[config.providers.storage] || providers.mock).createUploadUrl(args); },
  publicUrl(key) { return (providers[config.providers.storage] || providers.mock).publicUrl(key); },
};

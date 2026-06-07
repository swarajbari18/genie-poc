import { Storage } from '@google-cloud/storage';
// Local dev: set GOOGLE_APPLICATION_CREDENTIALS=/abs/path/to/service-account-key.json
// Cloud Run: runtime SA must have roles/iam.serviceAccountTokenCreator on itself
export const storage = new Storage({
    projectId: process.env.GOOGLE_CLOUD_PROJECT,
});
export const contractsBucket = storage.bucket(process.env.GCS_BUCKET_NAME);
export class GcsSigningError extends Error {
    constructor(cause) {
        super('GCS signing failed — set GOOGLE_APPLICATION_CREDENTIALS (local) or grant tokenCreator role (Cloud Run)');
        this.name = 'GcsSigningError';
        this.cause = cause;
    }
}
export async function generateDownloadSignedUrl(storageKey, filename, expiresInSeconds = 3600, disposition = 'attachment') {
    const responseDisposition = disposition === 'inline'
        ? 'inline'
        : `attachment; filename="${encodeURIComponent(filename)}"`;
    try {
        const [url] = await contractsBucket.file(storageKey).getSignedUrl({
            version: 'v4',
            action: 'read',
            expires: Date.now() + expiresInSeconds * 1000,
            responseDisposition,
            responseType: 'application/pdf',
        });
        return url;
    }
    catch (err) {
        console.error('[storage] GCS signing failed — set GOOGLE_APPLICATION_CREDENTIALS (local) or grant tokenCreator role (Cloud Run)', err);
        throw new GcsSigningError(err);
    }
}

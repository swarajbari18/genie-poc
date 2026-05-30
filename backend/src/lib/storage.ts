import { Storage } from '@google-cloud/storage'

// ADC is automatic on Cloud Run (metadata server provides credentials)
// For local dev: run `gcloud auth application-default login`
export const storage = new Storage({
  projectId: process.env.GOOGLE_CLOUD_PROJECT,
})

export const contractsBucket = storage.bucket(process.env.GCS_BUCKET_NAME!)

export async function generateDownloadSignedUrl(
  storageKey: string,
  filename: string,
  expiresInSeconds = 3600,
): Promise<string> {
  const [url] = await contractsBucket.file(storageKey).getSignedUrl({
    version: 'v4',
    action: 'read',
    expires: Date.now() + expiresInSeconds * 1000,
    responseDisposition: `attachment; filename="${encodeURIComponent(filename)}"`,
    responseType: 'application/pdf',
  })
  return url
}

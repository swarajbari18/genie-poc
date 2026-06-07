const CLOUD_RUN_HOST = 'genie-backend-501256442143.europe-west2.run.app'

export default {
  async fetch(request) {
    const url = new URL(request.url)
    url.hostname = CLOUD_RUN_HOST
    url.protocol = 'https:'
    url.port = ''

    return fetch(url.toString(), {
      method: request.method,
      headers: request.headers,
      body: ['GET', 'HEAD'].includes(request.method) ? null : request.body,
      redirect: 'manual',
    })
  },
}

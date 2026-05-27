import * as core from '@actions/core'
import { createHmac, randomUUID } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'

const AMO_BASE = 'https://addons.mozilla.org/api/v5'

interface UploadResponse {
  uuid: string
  channel: 'listed' | 'unlisted'
  processed: boolean
  submitted: boolean
  url: string
  valid: boolean
  validation: Record<string, unknown>
  version: string | null
}

interface VersionResponse {
  id: number
  channel: string
  file: { status: string }
  license: { slug: string } | null
  release_notes: Record<string, string> | null
  version: string
}

function b64url(data: string | Buffer): string {
  const buf = typeof data === 'string' ? Buffer.from(data) : data
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '')
}

function makeJwt(apiKey: string, apiSecret: string): string {
  const now = Math.floor(Date.now() / 1000)
  const header = b64url(JSON.stringify({ alg: 'HS256', typ: 'JWT' }))
  const payload = b64url(JSON.stringify({ iss: apiKey, jti: randomUUID(), iat: now, exp: now + 300 }))
  const signature = b64url(createHmac('sha256', apiSecret).update(`${header}.${payload}`).digest())
  return `${header}.${payload}.${signature}`
}

async function assertOk(response: Response, context: string): Promise<void> {
  if (!response.ok) {
    const body = await response.text()
    throw new Error(`${context}: HTTP ${response.status} — ${body}`)
  }
}

async function uploadXpi(
  apiKey: string,
  apiSecret: string,
  xpiPath: string,
  channel: 'listed' | 'unlisted',
): Promise<UploadResponse> {
  const form = new FormData()
  const data = readFileSync(xpiPath)
  form.append('upload', new Blob([data], { type: 'application/x-xpinstall' }), basename(xpiPath))
  form.append('channel', channel)

  const response = await fetch(`${AMO_BASE}/addons/upload/`, {
    method: 'POST',
    headers: { Authorization: `JWT ${makeJwt(apiKey, apiSecret)}` },
    body: form,
  })
  await assertOk(response, 'Firefox upload')
  return (await response.json()) as UploadResponse
}

async function pollUpload(
  apiKey: string,
  apiSecret: string,
  uuid: string,
  intervalMs = 5_000,
  timeoutMs = 300_000,
): Promise<UploadResponse> {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    await new Promise(resolve => setTimeout(resolve, intervalMs))

    const response = await fetch(`${AMO_BASE}/addons/upload/${uuid}/`, {
      headers: { Authorization: `JWT ${makeJwt(apiKey, apiSecret)}` },
    })
    await assertOk(response, 'Firefox upload poll')
    const upload = (await response.json()) as UploadResponse
    core.info(`  processed: ${upload.processed}, valid: ${upload.valid}`)

    if (upload.processed) return upload
  }

  throw new Error(`Firefox upload timed out after ${timeoutMs / 1000}s`)
}

async function createVersion(
  apiKey: string,
  apiSecret: string,
  extensionId: string,
  uploadUuid: string,
  license: string | undefined,
  approvalNotes: string | undefined,
  releaseNotes: string | undefined,
): Promise<VersionResponse> {
  const body: Record<string, unknown> = { upload: uploadUuid }

  if (license) body['license'] = license
  if (approvalNotes) body['approval_notes'] = approvalNotes

  if (releaseNotes) {
    try {
      body['release_notes'] = JSON.parse(releaseNotes)
    } catch {
      body['release_notes'] = { 'en-US': releaseNotes }
    }
  }

  const response = await fetch(`${AMO_BASE}/addons/addon/${extensionId}/versions/`, {
    method: 'POST',
    headers: {
      Authorization: `JWT ${makeJwt(apiKey, apiSecret)}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  })
  await assertOk(response, 'Firefox create version')
  return (await response.json()) as VersionResponse
}

export async function publishToFirefox(): Promise<void> {
  const apiKey = core.getInput('firefox-api-key')
  const apiSecret = core.getInput('firefox-api-secret')
  const extensionId = core.getInput('firefox-extension-id')
  const xpiPath = core.getInput('firefox-xpi-path')

  if (!apiKey && !apiSecret && !extensionId && !xpiPath) {
    core.info('Firefox Add-ons: no inputs provided — skipping.')
    return
  }

  const channel = (core.getInput('firefox-channel') || 'listed') as 'listed' | 'unlisted'
  const license = core.getInput('firefox-license') || undefined
  const approvalNotes = core.getInput('firefox-approval-notes') || undefined
  const releaseNotes = core.getInput('firefox-release-notes') || undefined

  // 1. Upload
  core.info(`Firefox Add-ons: uploading ${xpiPath} (channel: ${channel})...`)
  let upload = await uploadXpi(apiKey, apiSecret, xpiPath, channel)
  core.info(`  uuid: ${upload.uuid}`)

  // 2. Poll until processed
  if (!upload.processed) {
    core.info('Firefox Add-ons: waiting for validation...')
    upload = await pollUpload(apiKey, apiSecret, upload.uuid)
  }

  core.setOutput('firefox-upload-uuid', upload.uuid)

  if (!upload.valid) {
    throw new Error(`Firefox Add-ons: upload failed validation.\n${JSON.stringify(upload.validation, null, 2)}`)
  }

  core.info('Firefox Add-ons: upload valid. Creating version...')

  // 3. Create version
  const version = await createVersion(apiKey, apiSecret, extensionId, upload.uuid, license, approvalNotes, releaseNotes)

  core.setOutput('firefox-version-id', String(version.id))
  core.setOutput('firefox-version-state', version.file.status)
  core.info(`Firefox Add-ons: done. Version ${version.version}, state: ${version.file.status}`)
}

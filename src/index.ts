import * as core from '@actions/core'
import { publishToChrome } from './chrome'
import { publishToEdge } from './edge'
import { publishToFirefox } from './firefox'

async function run(): Promise<void> {
  const errors: string[] = []

  for (const [name, fn] of [
    ['Chrome Web Store', publishToChrome],
    ['Firefox Add-ons', publishToFirefox],
    ['Edge Add-ons', publishToEdge],
  ] as const) {
    try {
      await fn()
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      core.error(`${name}: ${message}`)
      errors.push(name)
    }
  }

  if (errors.length > 0) {
    core.setFailed(`Failed: ${errors.join(', ')}`)
  }
}

run()

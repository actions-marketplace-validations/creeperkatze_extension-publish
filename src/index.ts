import * as core from '@actions/core'
import { publishToChrome } from './chrome'
import { publishToFirefox } from './firefox'

async function run(): Promise<void> {
  try {
    await publishToChrome()
    await publishToFirefox()
  } catch (error) {
    core.setFailed(error instanceof Error ? error.message : String(error))
  }
}

run()

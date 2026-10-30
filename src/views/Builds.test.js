// @vitest-environment jsdom
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { mount, flushPromises } from '@vue/test-utils'
import { createPinia, setActivePinia } from 'pinia'
import { createRouter, createMemoryHistory } from 'vue-router'
import * as buildsApi from '../lib/buildsApi'
import Builds from './Builds.vue'

vi.mock('../lib/buildsApi', () => ({ listBuilds: vi.fn(), getModeratorStatus: vi.fn() }))

const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:p(.*)', component: { render: () => null } }] })

beforeEach(() => {
  setActivePinia(createPinia())
  localStorage.clear()
  vi.mocked(buildsApi.listBuilds).mockReset()
})

async function open() {
  const wrapper = mount(Builds, { global: { plugins: [router], stubs: { BuildCard: true, BuildsPager: true } } })
  await router.isReady()
  await flushPromises()
  return wrapper
}

describe('Builds when the server cannot be reached', () => {
  it('says so in plain words instead of showing the browser error', async () => {
    buildsApi.listBuilds.mockRejectedValue(new TypeError('Failed to fetch'))
    const w = await open()
    const error = w.find('.b-error')
    expect(error.exists()).toBe(true)
    expect(error.text()).not.toContain('Failed to fetch')
    expect(error.text()).toContain('did not answer')
  })

  it('does the same when the API answers with a failure', async () => {
    buildsApi.listBuilds.mockRejectedValue(Object.assign(new Error('Request failed (500)'), { status: 500 }))
    const w = await open()
    expect(w.find('.b-error').text()).not.toContain('Request failed')
  })

  it('offers a Retry that loads again and clears the error', async () => {
    buildsApi.listBuilds.mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValueOnce([])
    const w = await open()
    await w.find('.b-error button').trigger('click')
    await flushPromises()
    expect(buildsApi.listBuilds).toHaveBeenCalledTimes(2)
    expect(w.find('.b-error').exists()).toBe(false)
    expect(w.find('.b-empty').exists()).toBe(true)
  })
})

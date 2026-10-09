// Real local backend acceptance: batch category, persistence, private tags and mobile layout.
// Start dev-local.ps1 first, then run: node e2e/local-category-verify.mjs
import { chromium, expect } from '@playwright/test'
import { mkdirSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const base = process.env.QA_BASE_URL ?? 'http://127.0.0.1:5173'
const output = fileURLToPath(new URL('../baseline/local-category/', import.meta.url))
mkdirSync(output, { recursive: true })
const browser = await chromium.launch({ channel: process.env.QA_BROWSER_CHANNEL ?? 'chrome' })
const setup = await browser.newContext()
const createdIDs = []
let headers

async function json(response) {
  expect(response.ok(), `${response.url()} returned ${response.status()}`).toBe(true)
  return response.json()
}

try {
  // Reuse the demo media, but create disposable cards under a separate QA account.
  const sourceAuth = await json(await setup.request.post(`${base}/api/auth/login`, {
    data: { username: process.env.QA_USERNAME ?? 'localdemo', password: process.env.QA_PASSWORD ?? 'localdemo123' },
  }))
  const sourceHeaders = { Authorization: `Bearer ${sourceAuth.token}` }
  const sourceCards = await json(await setup.request.get(`${base}/api/cards/mine`, { headers: sourceHeaders }))
  const source = await json(await setup.request.get(`${base}/api/cards/${sourceCards[0].id}`, { headers: sourceHeaders }))
  const cover = await setup.request.get(`${base}${source.card.cover_url}`)
  const audio = await setup.request.get(`${base}${source.audios[0].audio_url}`)
  expect(cover.ok() && audio.ok()).toBe(true)
  const username = `qa${Date.now().toString(36)}`
  const password = 'local-category-test123'
  const auth = await json(await setup.request.post(`${base}/api/auth/register`, { data: { username, password } }))
  headers = { Authorization: `Bearer ${auth.token}` }
  const names = ['归类验收一', '归类验收二', '未勾选验收牌']
  for (const name of names) {
    const card = await json(await setup.request.post(`${base}/api/cards`, {
      headers,
      multipart: {
        display_text: name, series: '批量归类验收', tags: '原标签',
        cover: { name: 'sample.png', mimeType: 'image/png', buffer: await cover.body() },
        audio: { name: 'sample.wav', mimeType: 'audio/wav', buffer: await audio.body() },
      },
    }))
    createdIDs.push(card.id)
  }
  await json(await setup.request.patch(`${base}/api/cards/${createdIDs[0]}`, {
    headers, data: { share_level: 'private', tags: '原标签,私有旧分类' },
  }))

  const results = []
  for (const [name, viewport] of [
    ['desktop', { width: 1440, height: 900 }],
    ['mobile', { width: 390, height: 844 }],
  ]) {
    const context = await browser.newContext({ viewport })
    try {
      const page = await context.newPage()
      const errors = []
      page.on('pageerror', error => errors.push(error.message))
      await page.goto(`${base}/cards`)
      await page.getByPlaceholder('输入昵称').fill(username)
      await page.getByPlaceholder('输入密码').fill(password)
      await page.getByRole('button', { name: '进入战场' }).click()
      await expect(page).toHaveURL(`${base}/cards`)
      await expect(page.getByText('更新日志', { exact: true })).toBeVisible()
      await page.keyboard.press('Escape')
      await expect(page.getByText('更新日志', { exact: true })).not.toBeVisible()
      await page.getByRole('button', { name: '批量归类' }).click()
      await expect(page.getByRole('checkbox')).toHaveCount(3)
      const first = page.getByRole('checkbox', { name: `选择${names[0]}` })
      expect(await first.evaluate(element => element.classList.contains('rounded-full'))).toBe(true)
      await first.click()
      await expect(first).toHaveAttribute('aria-checked', 'true')
      // The whole card can also toggle the circle without opening the drawer.
      await page.getByText(names[1], { exact: true }).click()
      await expect(page.getByRole('checkbox', { name: `选择${names[1]}` })).toHaveAttribute('aria-checked', 'true')
      await expect(page.getByRole('checkbox', { name: `选择${names[2]}` })).toHaveAttribute('aria-checked', 'false')
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true)
      await page.screenshot({ path: `${output}/${name}-selection.png`, fullPage: true })
      await page.getByRole('button', { name: '完成', exact: true }).click()
      const dialog = page.getByRole('dialog')
      await expect(dialog.getByRole('button', { name: '私有旧分类', exact: true })).toBeVisible()
      const category = name === 'desktop' ? '桌面归类验收' : '手机归类验收'
      await dialog.getByLabel('分类名称').fill(category)
      await expect.poll(() => dialog.locator(':scope > div').evaluate(element => getComputedStyle(element).opacity)).toBe('1')
      await page.screenshot({ path: `${output}/${name}-category.png` })
      const responsePromise = page.waitForResponse(response => response.url().endsWith('/api/cards/batch-tag') && response.request().method() === 'POST')
      await dialog.getByRole('button', { name: '确认归类' }).click()
      expect((await json(await responsePromise)).applied).toBe(2)
      await expect(page.getByRole('dialog')).toHaveCount(0)
      await expect(page.getByRole('checkbox')).toHaveCount(0)
      const categoryFilter = page.getByRole('tablist', { name: '标签筛选' }).getByRole('tab', { name: new RegExp(category) })
      await expect(categoryFilter).toBeVisible()
      await categoryFilter.click()
      await expect(page.getByText(names[0], { exact: true })).toBeVisible()
      await expect(page.getByText(names[1], { exact: true })).toBeVisible()
      await expect(page.getByText(names[2], { exact: true })).toHaveCount(0)
      for (let i = 0; i < createdIDs.length; i++) {
        const { card } = await json(await setup.request.get(`${base}/api/cards/${createdIDs[i]}`, { headers }))
        expect(card.tags.split(',')).toContain('原标签')
        expect(card.tags.split(',').includes(category)).toBe(i < 2)
      }
      await page.reload()
      await expect(page.getByRole('tablist', { name: '标签筛选' }).getByRole('tab', { name: new RegExp(category) })).toBeVisible()
      expect(errors).toEqual([])
      results.push({ viewport: name, circles: 'ok', classifySelectedOnly: 'ok', privateTags: 'ok', persistence: 'ok', layout: 'ok' })
    } finally {
      await context.close()
    }
  }
  console.log(JSON.stringify(results, null, 2))
} finally {
  for (const id of createdIDs) {
    const response = await setup.request.delete(`${base}/api/cards/${id}`, { headers })
    if (!response.ok()) console.error(`Failed to clean up test card ${id}: ${response.status()}`)
  }
  await setup.close()
  await browser.close()
}

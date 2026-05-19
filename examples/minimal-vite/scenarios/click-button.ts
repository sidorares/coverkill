import type { ScenarioContext } from '../../../src/config/types.js';

export default async function ({ page, baseURL }: ScenarioContext) {
  await page.goto(baseURL);
  await page.getByRole('button', { name: 'Click me' }).click();
}

// @vitest-environment jsdom
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, vi } from 'vitest'
import { apply, inject } from '../src/client/index.ts'

function bench(): { addLanguage: ReturnType<typeof vi.fn>; register: ReturnType<typeof vi.fn> } {
  const addLanguage = vi.fn(() => vi.fn())
  const register = vi.fn(() => vi.fn())
  const ctx = new Context()
  ctx.provide('locale', { addLanguage, register } as never)
  apply(ctx)
  return { addLanguage, register }
}

describe('locale-es', () => {
  it('declares the locale service edge', () => {
    expect(inject).toEqual(['locale'])
  })

  it('registers Spanish with an English fallback and translates owned namespaces', () => {
    const { addLanguage, register } = bench()
    expect(addLanguage).toHaveBeenCalledWith({ id: 'es', label: 'Español', fallback: 'en' })
    expect(register).toHaveBeenCalledWith('approval', 'es', expect.objectContaining({ allowOnce: 'Permitir una vez' }))
    expect(register).toHaveBeenCalledWith('settings.locale', 'es', expect.objectContaining({ 'language.title': 'Idioma' }))
  })
})

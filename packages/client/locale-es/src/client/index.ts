/**
 * Spanish (es) language pack. Registers the language with an English fallback and supplies the
 * Spanish dictionaries for the namespaces this custom harness targets; keys without a Spanish entry
 * fall back to `en`, so the pack is incremental.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-locale/client'

/** Required service: the locale registry. */
export const inject = ['locale']

/** Stable BCP 47-style id stored as the locale preference. */
const ES = 'es'

/**
 * Register Spanish and its dictionaries. Each registration rides an effect so unloading the plugin
 * removes the language and the dictionaries.
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(
    () => ctx.locale.addLanguage({ id: ES, label: 'Español', fallback: 'en' }),
    'locale-es: language',
  )
  ctx.effect(
    () => ctx.locale.register('approval', ES, {
      waiting: 'Esperando aprobación',
      'detail.aria': 'Detalles de la aprobación',
      escalation: 'La herramienta {toolName} solicita ejecución privilegiada',
      reject: 'Rechazar',
      allowOnce: 'Permitir una vez',
    }),
    'locale-es: approval',
  )
  ctx.effect(
    () => ctx.locale.register('settings.locale', ES, {
      'language.title': 'Idioma',
    }),
    'locale-es: settings.locale',
  )
}

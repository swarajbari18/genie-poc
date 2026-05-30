type Level = 'INFO' | 'WARN' | 'ERROR'

const CONTEXT_WIDTH = 16

function format(level: Level, context: string, message: string, data?: Record<string, unknown>): string {
  const ts  = new Date().toISOString().slice(11, 23)   // HH:MM:SS.mmm
  const lvl = level.padEnd(5)
  const ctx = context.padEnd(CONTEXT_WIDTH)
  const line = `${ts}  ${lvl}  ${ctx}  ${message}`
  return data ? `${line}  ${JSON.stringify(data)}` : line
}

export const log = {
  info(context: string, message: string, data?: Record<string, unknown>) {
    console.log(format('INFO', context, message, data))
  },
  warn(context: string, message: string, data?: Record<string, unknown>) {
    console.warn(format('WARN', context, message, data))
  },
  error(context: string, message: string, data?: Record<string, unknown>) {
    console.error(format('ERROR', context, message, data))
  },
}

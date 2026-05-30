const CONTEXT_WIDTH = 16;
function format(level, context, message, data) {
    const ts = new Date().toISOString().slice(11, 23); // HH:MM:SS.mmm
    const lvl = level.padEnd(5);
    const ctx = context.padEnd(CONTEXT_WIDTH);
    const line = `${ts}  ${lvl}  ${ctx}  ${message}`;
    return data ? `${line}  ${JSON.stringify(data)}` : line;
}
export const log = {
    info(context, message, data) {
        console.log(format('INFO', context, message, data));
    },
    warn(context, message, data) {
        console.warn(format('WARN', context, message, data));
    },
    error(context, message, data) {
        console.error(format('ERROR', context, message, data));
    },
};

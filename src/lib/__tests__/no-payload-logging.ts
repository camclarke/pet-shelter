/**
 * The no-logging ALLOWLIST, shared by application-wiring.test.ts and
 * application-identity.test.ts. Not a test file itself (no `.test.`), so the
 * runner never loads it on its own.
 *
 * Review 4c-1 #3: the old check was a DENYLIST of words ("answers", "draft",
 * "notes"…) after the message string, so logging `identity`, `submission` or
 * `home` passed. Now a console call may log a leading message string and, at
 * most, ONE of the error-code forms below — nothing else. And a variable named
 * `code` may only ever hold an error code, so it cannot smuggle a payload.
 *
 * A private person's C.I., two strangers' phones and a home address are what
 * flows through these files; an error code is all a log may carry.
 */

/** Comments removed, so prose like "the admin console." cannot trip or satisfy a check. */
export function stripComments(source: string): string {
  return source
    .replace(/\r\n/g, '\n')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1');
}

/** The only things a log line may carry after its message string. */
const ALLOWED_ARGUMENTS = [
  'code',
  'errorCode(caught)',
  '(caught as { code?: string })?.code',
  '(caught as { name?: string })?.name',
];

/** The only things `const code` may be. */
const ALLOWED_CODE_SOURCES = ['errorCode(caught)', '(caught as { code?: string })?.code'];

const CONSOLE_CALL = /console\.(error|warn|log|info|debug|trace|dir|table)\s*\(/;

/** Everything wrong with how a file logs, in words. Empty when it only logs error codes. */
export function payloadLoggingProblems(file: string, source: string): string[] {
  const problems: string[] = [];
  const src = stripComments(source);

  for (const raw of src.split('\n')) {
    const line = raw.trim();
    const call = CONSOLE_CALL.exec(line);
    if (!call) continue;
    const rest = line.slice(call.index + call[0].length);
    // A leading message string, on the same line, in single quotes.
    const message = /^'(?:[^'\\]|\\.)*'/.exec(rest);
    if (!message) {
      problems.push(`${file}: a console call without a leading message string: ${line}`);
      continue;
    }
    const after = rest.slice(message[0].length).trim();
    if (after === ');') continue; // the message alone
    const argument = /^,\s*(.*)\);$/.exec(after);
    if (!argument || !ALLOWED_ARGUMENTS.includes(argument[1]!.trim())) {
      problems.push(`${file}: logs something other than an error code: ${line}`);
    }
  }

  // A declaration, with or without a type annotation.
  const DECLARATION = /\b(?:const|let|var)\s+code\s*(?::[^=;\n]+)?=(?!=)\s*([^;\n]+);/g;
  for (const m of src.matchAll(DECLARATION)) {
    if (!ALLOWED_CODE_SOURCES.includes(m[1]!.trim())) {
      problems.push(`${file}: \`code\` is assigned something other than an error code: ${m[0]}`);
    }
  }
  // A later reassignment (`code = …`) is refused outright: the forms above are
  // only safe as the declaration.
  const withoutDeclarations = src.replace(DECLARATION, '');
  for (const m of withoutDeclarations.matchAll(/(?<![.\w])code\s*=(?!=)/g)) {
    problems.push(`${file}: \`code\` is reassigned: ${m[0]}`);
  }
  return problems;
}

/**
 * Deploy storage.rules — because `firebase deploy --only storage` cannot.
 *
 * ── Why this script exists ─────────────────────────────────────────────────
 * The Firebase CLI refuses with:
 *
 *     Error: Firebase Storage has not been set up on project 'wawitas'.
 *     Go to .../storage and click 'Get Started'.
 *
 * That message is misleading. Storage *is* set up: `wawitas-app` exists and is
 * registered as a Firebase Storage bucket (terraform/storage.tf, via
 * google_firebase_storage_bucket). What the CLI actually checks for is a
 * **default** bucket — the one the console's "Get Started" button creates —
 * and this project deliberately does not have one. Setting `storage.bucket` in
 * firebase.json does not satisfy the check.
 *
 * Clicking "Get Started" would fix the CLI and create a SECOND, competing
 * bucket, splitting media across two places and leaving it ambiguous which one
 * storage.rules protects. That was considered and rejected — see CLAUDE.md,
 * open decision #2.
 *
 * ── What the CLI does underneath ───────────────────────────────────────────
 * Two plain Rules API calls, neither of which cares about a default bucket:
 *
 *   1. create a ruleset from the source file
 *   2. point a release at it, named `firebase.storage/{bucket}`
 *
 * The bucket is encoded in the RELEASE NAME, which is precisely the hook a
 * named bucket needs. So the CLI's precondition is stricter than the API's.
 *
 * ── Deliberately not in CI ────────────────────────────────────────────────
 * Security rules stay a manual, reviewed deploy, exactly like firestore.rules.
 * CLAUDE.md's reasoning holds: an unreviewed automatic rules deploy is worse
 * than a manual one until there is a rules test in front of it.
 *
 * Usage:  npm run deploy:storage-rules
 */

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { GoogleAuth } from 'google-auth-library';

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');

// Read both the bucket and the rules path out of firebase.json rather than
// hardcoding them. A shelter forking this template must not inherit Wawitas'
// bucket name silently.
const firebaseJson = JSON.parse(readFileSync(join(REPO_ROOT, 'firebase.json'), 'utf8'));
const bucket = firebaseJson.storage?.bucket;
const rulesFile = firebaseJson.storage?.rules;

if (!bucket || !rulesFile) {
  throw new Error('firebase.json needs storage.bucket and storage.rules');
}

// The project id comes from the same place everything else server-side gets it,
// so this cannot quietly target a different project than the app does.
const project = process.env.GOOGLE_CLOUD_PROJECT ?? process.env.GCLOUD_PROJECT;
if (!project) {
  throw new Error(
    'GOOGLE_CLOUD_PROJECT is not set. Refusing to guess — rules are the authorization layer.',
  );
}

const auth = new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] });
const client = await auth.getClient();

async function api(method, path, data) {
  const res = await client.request({
    url: `https://firebaserules.googleapis.com/v1/${path}`,
    method,
    headers: { 'x-goog-user-project': project },
    data,
  });
  return res.data;
}

const content = readFileSync(join(REPO_ROOT, rulesFile), 'utf8');
console.log(`${rulesFile}: ${content.length} chars → project ${project}, bucket ${bucket}`);

const ruleset = await api('POST', `projects/${project}/rulesets`, {
  source: { files: [{ name: rulesFile, content }] },
});
console.log(`ruleset: ${ruleset.name}`);

const releaseName = `projects/${project}/releases/firebase.storage/${bucket}`;

try {
  await api('POST', `projects/${project}/releases`, {
    name: releaseName,
    rulesetName: ruleset.name,
  });
  console.log(`release created: ${releaseName}`);
} catch (err) {
  const status = err?.response?.status;
  if (status !== 409) throw err;
  // On a re-run the release already exists. Update it — otherwise the ruleset
  // uploaded above sits there unreleased and completely inert, which looks
  // exactly like a successful deploy.
  await api('PATCH', `${releaseName}?updateMask=rulesetName`, {
    release: { name: releaseName, rulesetName: ruleset.name },
  });
  console.log(`release updated: ${releaseName}`);
}

// Verify by reading the live ruleset back and diffing it, rather than trusting
// the write's own response. This project has been bitten by "the deploy said
// OK" more than once.
const live = await api('GET', ruleset.name.replace(/^/, ''));
const deployed = live.source.files[0].content;

if (deployed !== content) {
  throw new Error('DEPLOYED RULES DO NOT MATCH THE LOCAL FILE — do not trust this deploy');
}
console.log('verified: deployed ruleset matches the local file byte-for-byte');

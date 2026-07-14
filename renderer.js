// Scout Desktop — renderer.js (v2.4.1)

// IIFE wraps the whole file so `let supabase` doesn't collide with the
// global `var supabase` exported by vendor/supabase.min.js (UMD).
;(() => {

// ---- Platform ----

const PLATFORM = (() => {
  const p = window.electronAPI?.platform || 'win32'
  const isWin = p === 'win32', isMac = p === 'darwin', isLinux = p === 'linux'
  return {
    raw: p,
    isWin, isMac, isLinux,
    label:       isWin ? 'Windows'   : isMac ? 'macOS' : 'Linux',
    shellLabel:  isWin ? 'PowerShell': isMac ? 'zsh/bash' : 'bash',
    shellSyntax: isWin ? 'PowerShell (Get-ChildItem, $env:VAR, ;)'
                       : 'POSIX shell (ls, cd, $VAR, /usr/bin)',
    homeHint:    isWin ? 'C:\\Users\\<you>' : isMac ? '/Users/<you>' : '/home/<you>',
    defaultEnvPath(user) {
      const handle = (user?.email || 'user').split('@')[0]
      if (isWin)   return `C:\\Users\\${handle}\\.env`
      if (isMac)   return `/Users/${handle}/.env`
      return `/home/${handle}/.env`
    },
  }
})()

// ---- Settings ----

async function getSetting(key, fallback) {
  const v = await window.electronAPI.getSettings(key)
  return v !== null ? v : fallback
}
async function setSetting(key, value) { return window.electronAPI.setSettings(key, value) }
async function getMicEnabled()    { return getSetting('mic_enabled', true) }
async function getRecordingMode() {
  const m = await getSetting('recording_mode', 'skill')
  return m === 'improvement' ? 'improvement' : 'skill'
}

// ---- Supabase ----

const SUPABASE_URL      = 'https://fzcssialkdybftxmpmhm.supabase.co'
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImZ6Y3NzaWFsa2R5YmZ0eG1wbWhtIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzczMjY3ODcsImV4cCI6MjA5MjkwMjc4N30.DS0UxNbPmBBoMiVeGvQ2S81QOzjsLATq5mA4vFdfpm4'

let supabase    = null
let currentUser = null

async function initSupabase() {
  if (!window.supabase) return
  supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY, {
    auth: { persistSession: false, autoRefreshToken: false },
  })
  // No-auth mode: fixed local user UUID. Matches the placeholder returned by
  // verifyAuthUser() in the edge functions when called with the anon key, so
  // their `.eq("user_id", user.id)` queries find the rows this client wrote.
  currentUser = { id: '00000000-0000-0000-0000-000000000001', email: 'local@scout' }
}

async function doSignOut() {
  if (!supabase) return
  await supabase.auth.signOut()
  currentUser = null
  await setSetting('supabase_session', null)
  view = { kind: 'auth', step: 'email', email: '' }
  render()
}

// Once a fetch fails (e.g. the Supabase project is paused/offline), stop
// trying for the rest of the session — otherwise every Library visit burns
// ~10s of DNS retries before falling back.
let supabaseUnreachable = false

async function loadLibraryData() {
  if (!supabase || !currentUser || supabaseUnreachable) return MOCK_RECORDINGS
  try {
    const { data, error } = await Promise.race([
      supabase
        .from('recordings')
        .select('*, skills(*)')
        .order('started_at', { ascending: false })
        .limit(50),
      new Promise((_, rej) => setTimeout(() => rej(new Error('backend timeout')), 2500)),
    ])
    if (error) throw error
    return data?.length ? data : []
  } catch (e) {
    console.warn('Library fetch failed, using mock data:', e)
    supabaseUnreachable = true
    return MOCK_RECORDINGS
  }
}

// ---- Local skill pipeline (no Supabase) ----
//
// When the hosted backend is unreachable, the whole record→skill flow can
// still run: the transcript was captured live in this renderer, keyframes
// come straight out of the video blob, and skill generation is a single
// direct Claude call through the main process. The skill lives in memory
// (Copy / Save .md / Run automatically all work); it just isn't synced.

async function extractKeyframes(blob, count = 4) {
  if (!blob || !blob.size) return []
  const url = URL.createObjectURL(blob)
  try {
    const video = document.createElement('video')
    video.muted = true; video.src = url
    await new Promise((res, rej) => {
      video.onloadedmetadata = res
      video.onerror = () => rej(new Error('video load failed'))
      setTimeout(() => rej(new Error('video load timeout')), 8000)
    })
    // MediaRecorder blobs often report Infinity until seeked far forward.
    if (!isFinite(video.duration)) {
      video.currentTime = 1e9
      await new Promise(r => { video.onseeked = r; setTimeout(r, 2000) })
    }
    const dur = isFinite(video.duration) ? video.duration : 0
    if (!dur || !video.videoWidth) return []
    const canvas = document.createElement('canvas')
    const scale = Math.min(1, 1280 / video.videoWidth)
    canvas.width  = Math.round(video.videoWidth * scale)
    canvas.height = Math.round(video.videoHeight * scale)
    const ctx = canvas.getContext('2d')
    const frames = []
    for (let i = 0; i < count; i++) {
      video.currentTime = dur * (i + 0.5) / count
      await new Promise(r => { video.onseeked = r; setTimeout(r, 1500) })
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height)
      frames.push(canvas.toDataURL('image/jpeg', 0.7).split(',')[1])
    }
    return frames
  } catch (e) {
    console.warn('Keyframe extraction failed:', e)
    return []
  } finally {
    URL.revokeObjectURL(url)
  }
}

const LOCAL_SKILL_SYSTEM = `You turn a screen recording of a user performing a task into a reusable "skill" — a step-by-step guide another person or an AI agent can follow to repeat the task.

Output ONLY the skill markdown, exactly in this format (no preamble, no code fence around the whole thing):

---
name: kebab-case-slug
version: 1
description: One sentence describing what this skill accomplishes.
---

# Title In Plain Words

## Goal
One or two sentences on the outcome.

## Steps
1. Numbered, concrete steps. Name the exact apps, buttons, URLs and values visible in the evidence. Use {placeholders} for values that will change run to run.

## Done when
The observable condition that proves the task succeeded.

Base every step on the evidence provided (screenshots, narration, window titles). Describe the ACTUAL apps, sites, buttons and text visible in the screenshots — read them carefully, they are the recording. Never write meta-steps like "perform the actions demonstrated in the recording"; if you genuinely cannot tell what the user did, write your best reading of the screenshots and mark uncertain steps with "(verify)".`

async function processRecordingLocal(rec, extraContext) {
  view = { kind: 'processing', recording: rec, stage: 'drafting', error: null }
  render()
  try {
    const speechText = (rec._speechTranscript || '').trim()
    const auto = buildScreenContext(rec)
    const mergedExtra = [auto, (extraContext || '').trim()].filter(Boolean).join('\n\n')
    // Frames captured live during recording are the reliable source; blob
    // extraction is the fallback for recordings made before live capture
    // existed (and returns [] for audio-only blobs).
    const frames = (rec._frames && rec._frames.length) ? rec._frames : await extractKeyframes(rec._blob)

    if (!frames.length && !speechText) {
      throw new Error("The recording had no usable evidence — no screen frames and no narration. Record again (talking through what you're doing helps), or use Macro mode for click/keystroke capture.")
    }

    const content = []
    for (const f of frames) content.push({ type: 'image', source: { type: 'base64', media_type: 'image/jpeg', data: f } })
    content.push({ type: 'text', text:
`Recording: "${rec.title || 'Untitled'}" — ${Math.round((rec.duration_ms || 0) / 1000)}s.
${frames.length ? `The ${frames.length} screenshots above are keyframes from the recording, in order.` : 'No screenshots available.'}
${speechText ? `\nUser narration:\n${speechText}` : '\nNo narration was captured.'}
${mergedExtra ? `\nContext:\n${mergedExtra}` : ''}

Write the skill.` })

    const r = await window.electronAPI.agentComplete({ system: LOCAL_SKILL_SYSTEM, content })
    if (r?.error === 'need_key') throw new Error('No Anthropic API key set. Run any macro with "Run in background" once to add it.')
    if (r?.error) throw new Error(r.error)
    const body_md = (r.text || '').trim()
    if (!body_md) throw new Error('Skill generation returned no content.')

    const title = (body_md.match(/^#\s+(.+)$/m)?.[1] || rec.title || 'Untitled skill').trim()
    const skill = {
      id: 'local-' + Date.now().toString(36),
      recording_id: rec.id,
      user_id: currentUser?.id,
      version: 1,
      kind: rec.mode ?? 'skill',
      title,
      body_md,
      created_at: new Date().toISOString(),
    }
    view = { kind: 'skill', recording: { ...rec, title, status: 'ready', skills: [skill] }, skill, allSkills: [skill] }
  } catch (err) {
    console.error('Local processing failed:', err)
    view = { kind: 'processing', recording: rec, stage: 'drafting', error: err.message }
  }
  render()
}

async function processRecording(rec, extraContext) {
  if (!supabase || !currentUser) {
    view = { kind: 'idle', tab: 'library' }
    render()
    return
  }

  // Known-dead backend: don't waste time on uploads that will fail.
  if (supabaseUnreachable) return processRecordingLocal(rec, extraContext)

  const { data: sessionData } = await supabase.auth.getSession()
  const token = SUPABASE_ANON_KEY
  if (!token) {
    view = { kind: 'idle', tab: 'library' }
    render()
    return
  }

  view = { kind: 'processing', recording: rec, stage: 'uploading', error: null }
  render()

  try {
    // 1. Update the recording row inserted at startRecording (or insert if missing).
    const { error: updErr } = await supabase.from('recordings').update({
      status:       'uploading',
      ended_at:     new Date().toISOString(),
      duration_ms:  rec.duration_ms,
    }).eq('id', rec.id)
    if (updErr) {
      // Row might not exist yet (e.g. pre-insert failed). Upsert it.
      const { error: insertErr } = await supabase.from('recordings').upsert({
        id:           rec.id,
        user_id:      currentUser.id,
        title:        rec.title,
        status:       'uploading',
        started_at:   rec.started_at,
        ended_at:     new Date().toISOString(),
        duration_ms:  rec.duration_ms,
        mode:         rec.mode,
        transcript:   { segments: [] },
        meta:         { platform: window.electronAPI.platform, ua: navigator.userAgent },
      })
      if (insertErr) throw insertErr
    }

    // 2. Upload audio blob
    const audioPath = `${currentUser.id}/${rec.id}.webm`
    const { error: uploadErr } = await supabase.storage
      .from('audio')
      .upload(audioPath, rec._blob, { contentType: rec._isAudioOnly ? 'audio/webm' : 'video/webm', upsert: true })
    if (uploadErr) throw uploadErr

    await supabase.from('recordings').update({ audio_path: audioPath, status: 'transcribing' }).eq('id', rec.id)

    view = { kind: 'processing', recording: rec, stage: 'transcribing', error: null }
    render()

    // 3. Transcribe — prefer the Web Speech transcript captured live in the
    //    renderer; fall back to the /transcribe edge function (which currently
    //    returns empty because Claude doesn't natively transcribe webm).
    const speechText = (rec._speechTranscript || '').trim()
    if (speechText) {
      const segments = [{ start_ms: 0, end_ms: rec.duration_ms || 0, text: speechText }]
      await supabase.from('recordings').update({ transcript: { segments }, status: 'ready' }).eq('id', rec.id)
    } else {
      const txRes = await fetch(`${SUPABASE_URL}/functions/v1/transcribe`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body:    JSON.stringify({ recording_id: rec.id }),
      })
      if (!txRes.ok) {
        const body = await txRes.json().catch(() => ({}))
        throw new Error(body.error || `Transcription failed (${txRes.status})`)
      }
    }

    view = { kind: 'processing', recording: rec, stage: 'drafting', error: null }
    render()

    // 4. Generate skill — SSE stream.
    // Merge auto-captured screen context (focused app/window) with any
    // user-supplied extra text so the edge function gets both in one field.
    const auto = buildScreenContext(rec)
    const mergedExtra = [auto, (extraContext || '').trim()].filter(Boolean).join('\n\n')
    const skillRes = await fetch(`${SUPABASE_URL}/functions/v1/generate-skill`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body:    JSON.stringify({
        recording_id: rec.id,
        ...(mergedExtra ? { extra: mergedExtra } : {}),
        ...(rec._window_at_start || rec._window_at_end
            ? { screen_context: { start: rec._window_at_start, end: rec._window_at_end, platform: PLATFORM.label } }
            : {}),
      }),
    })
    if (!skillRes.ok) {
      const body = await skillRes.json().catch(() => ({}))
      throw new Error(body.error || `Skill generation failed (${skillRes.status})`)
    }

    const ct = skillRes.headers.get('content-type') || ''
    let allSkills = [], finalSkill = null

    if (ct.includes('text/event-stream')) {
      const reader = skillRes.body.getReader()
      const dec = new TextDecoder()
      let buf = '', accumulated = '', streamError = null
      outer: while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buf += dec.decode(value, { stream: true })
        const lines = buf.split('\n')
        buf = lines.pop()
        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          let evt
          try { evt = JSON.parse(line.slice(6)) } catch { continue }
          if (evt.type === 'skill_chunk') {
            accumulated += evt.text
            const el = document.getElementById('live-skill-text')
            if (el) el.textContent = accumulated
          } else if (evt.type === 'done') {
            finalSkill = evt
            allSkills = evt.all || [evt]
          } else if (evt.type === 'error') {
            streamError = evt.message || 'Unknown skill-generation error'
            break outer
          }
        }
      }
      if (streamError) throw new Error(streamError)
    } else {
      const json = await skillRes.json()
      allSkills = json.all || (json.id ? [json] : [])
      finalSkill = allSkills[0]
    }

    if (finalSkill) {
      const title = finalSkill.title || rec.title
      // PostgrestBuilder is thenable but doesn't expose `.catch` — wrap.
      try { await supabase.from('recordings').update({ title, status: 'ready' }).eq('id', rec.id) } catch (_) { /* non-critical */ }
      const updatedRec = { ...rec, title, status: 'ready', skills: allSkills }
      const primary    = allSkills.find(s => (s.kind ?? 'skill') === (rec.mode ?? 'skill')) ?? allSkills[0]
      view = { kind: 'skill', recording: updatedRec, skill: primary, allSkills }
    } else {
      view = { kind: 'processing', recording: rec, stage: 'drafting', error: 'Skill generation returned no content. The recording was saved — try again from the Library.' }
    }
    render()
  } catch (err) {
    console.error('Processing failed:', err)
    // Network-level failure (offline backend) — switch to the local pipeline
    // instead of surfacing a dead-end error.
    if (/failed to fetch|network|fetch failed/i.test(err.message || '')) {
      supabaseUnreachable = true
      return processRecordingLocal(rec, extraContext)
    }
    view = { kind: 'processing', recording: rec, stage: 'uploading', error: err.message }
    render()
  }
}

async function exportAllSkills() {
  if (!supabase || !currentUser) return
  try {
    const { data, error } = await supabase
      .from('skills')
      .select('*')
      .order('created_at', { ascending: false })
    if (error) throw error
    if (!data?.length) { alert('No skills to export yet.'); return }
    if (!window.fflate) { alert('Zip library not loaded — try again in a moment.'); return }
    const files = {}
    for (const skill of data) {
      const slug = (skill.title || 'skill').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 50) || 'skill'
      const name = `${slug}-v${skill.version || 1}.md`
      files[name] = window.fflate.strToU8(skill.body_md || '')
    }
    const zipped = window.fflate.zipSync(files)
    await window.electronAPI.saveFile({
      defaultName: `scout-skills-${new Date().toISOString().slice(0,10)}.zip`,
      buffer:      Array.from(zipped),
      mimeType:    'ZIP Archive',
      extensions:  ['zip'],
    })
  } catch (e) {
    console.error('Export failed:', e)
    alert('Export failed: ' + (e.message || 'Unknown error'))
  }
}

// ---- Mock data (shown when not signed in) ----

const MOCK_SKILL_WEBFLOW = `---
name: publish-webflow-blog-post
version: 2
description: Publish a new blog post in Webflow CMS, including slug setup, SEO metadata, and scheduling.
---

# Publish Blog Post in Webflow

## Goal
Create and publish a new blog post in Webflow CMS with correct SEO settings.

## When to use
Whenever you need to publish a new post to the company blog hosted on Webflow.

## Inputs
- \`{post_title}\` — The title of the blog post
- \`{publish_date}\` — The date to schedule publication (ISO format: YYYY-MM-DD)

## Steps
1. Navigate to **cms.webflow.com** and sign in with your Orage credentials.
2. Open the **Blog Posts** collection from the left sidebar panel.
3. Click **New Item** in the top-right corner.
4. Set the **Name** field to {post_title} — this auto-generates the URL slug.
5. Review the slug: convert to lowercase, replace spaces with hyphens.
6. Write or paste the post body in the rich-text editor.
7. Expand **SEO Settings** and fill in the meta description (150 chars max).
8. Set **Publish Date** to {publish_date}.
9. Click **Save & Publish** — confirm the green success toast appears.

## Done when
The post URL resolves without a 404 and the Webflow dashboard shows **Published** status.`

const MOCK_SKILL_SUPABASE = `---
name: add-supabase-edge-function
version: 1
description: Create and deploy a Deno TypeScript edge function on Supabase.
---

# Add Supabase Edge Function

## Goal
Deploy a new serverless function to handle API requests in Supabase.

## Steps
1. In the Supabase Dashboard, navigate to **Edge Functions** in the left sidebar.
2. Click **New Function**.
3. Enter the function name in kebab-case (e.g. \`process-webhook\`).
4. Start from the boilerplate handler:
\`\`\`typescript
Deno.serve(async (req) => {
  const { name } = await req.json()
  return new Response(JSON.stringify({ hello: name }), {
    headers: { 'Content-Type': 'application/json' },
  })
})
\`\`\`
5. Click **Deploy** and wait for the build indicator to turn green (10–20s).

## Done when
\`curl -X POST {function_url}\` returns HTTP 200 with the expected JSON body.`

const MOCK_SKILL_EXPENSE = `---
name: submit-expensify-report
version: 1
description: Create and submit a monthly expense report in Expensify with receipts attached.
---

# Submit Expense Report in Expensify

## Goal
Compile and submit a monthly expense report in Expensify for manager approval.

## Inputs
- \`{report_name}\` — Name of the report, e.g. "May 2025 Expenses"

## Steps
1. Log in to **expensify.com** with your company SSO.
2. Click **New Report** in the top navigation bar.
3. Name the report {report_name}.
4. Click **Add Expenses** → **New Expense** for each line item.
5. Upload the receipt photo or PDF for each expense.
6. Once all items are added, click **Submit** → select your manager → **Submit Report**.

## Done when
You receive a confirmation email and the report shows **Submitted — Awaiting Approval**.`

const MOCK_SKILL_JIRA = `---
kind: improvement
version: 1
description: The Jira approval flow hides the reject button, causing users to accidentally approve tickets.
---

# Fix Hidden Reject Button in Jira Approval Flow

## What's broken
The **Reject** button is visually hidden below the fold on 13" screens inside a \`max-height: 60px\` container.

## Suggested fix
\`\`\`css
.approval-actions {
  display: flex;
  gap: 8px;
  overflow: visible;
}
.approval-actions .reject-btn {
  background: #ef4444;
  color: #fff;
}
\`\`\`

## Acceptance criteria
- [ ] Both buttons visible without scrolling on a 1280×800 viewport
- [ ] Reject button has a red/danger style`

const MOCK_RECORDINGS = [
  {
    id: 'mock-1', title: 'Publish a blog post on Webflow', status: 'ready',
    started_at: new Date(Date.now() - 2 * 86400000).toISOString(), duration_ms: 147000, mode: 'skill',
    transcript: { segments: [{ text: 'Opening Webflow editor…' }] },
    skills: [{ id: 's1', recording_id: 'mock-1', user_id: 'u1', version: 2, kind: 'skill', title: 'Publish Blog Post in Webflow', body_md: MOCK_SKILL_WEBFLOW, created_at: new Date(Date.now() - 2 * 86400000).toISOString() }],
  },
  {
    id: 'mock-2', title: 'Confusing approval flow in Jira', status: 'ready',
    started_at: new Date(Date.now() - 3 * 86400000).toISOString(), duration_ms: 78000, mode: 'improvement',
    transcript: { segments: [{ text: 'This approval screen keeps tripping everyone up…' }] },
    skills: [{ id: 's4', recording_id: 'mock-2', user_id: 'u1', version: 1, kind: 'improvement', title: 'Fix Jira Approval Flow', body_md: MOCK_SKILL_JIRA, created_at: new Date(Date.now() - 3 * 86400000).toISOString() }],
  },
  {
    id: 'mock-3', title: 'Add a new Supabase edge function', status: 'ready',
    started_at: new Date(Date.now() - 5 * 86400000).toISOString(), duration_ms: 93000, mode: 'skill',
    transcript: { segments: [{ text: 'Creating a new edge function in the Supabase dashboard…' }] },
    skills: [{ id: 's2', recording_id: 'mock-3', user_id: 'u1', version: 1, kind: 'skill', title: 'Add Supabase Edge Function', body_md: MOCK_SKILL_SUPABASE, created_at: new Date(Date.now() - 5 * 86400000).toISOString() }],
  },
  {
    id: 'mock-4', title: 'Submit expense report in Expensify', status: 'ready',
    started_at: new Date(Date.now() - 12 * 86400000).toISOString(), duration_ms: 210000, mode: 'skill',
    transcript: { segments: [{ text: 'Walking through the monthly expense report submission…' }] },
    skills: [{ id: 's3', recording_id: 'mock-4', user_id: 'u1', version: 1, kind: 'skill', title: 'Submit Expense Report', body_md: MOCK_SKILL_EXPENSE, created_at: new Date(Date.now() - 12 * 86400000).toISOString() }],
  },
]

// ---- App state ----

const root = document.getElementById('app')
let view = { kind: 'loading' }

// ---- Root render ----

function render() {
  root.innerHTML = ''

  if (view.kind === 'loading') { root.appendChild(loadingView()); return }
  if (view.kind === 'auth')    { root.appendChild(authView(view)); return }

  const wrap = document.createElement('div')
  wrap.className = 'animate-fade-in'
  wrap.style.cssText = 'display:flex;flex-direction:column;min-height:100vh;'
  wrap.appendChild(compactHeader())

  const divLine = document.createElement('div')
  divLine.className = 'divider-gold'
  divLine.style.cssText = 'margin:0 20px;'
  wrap.appendChild(divLine)

  const main = document.createElement('main')
  main.style.cssText = 'flex:1;overflow-y:auto;'

  switch (view.kind) {
    case 'idle':              main.appendChild(idleView(view.tab));                                                      break
    case 'recording':         main.appendChild(recordingView(view.state));                                               break
    case 'extra_context':     main.appendChild(extraContextView(view.recording));                                        break
    case 'processing':        main.appendChild(processingView(view.recording, view.stage, view.error));                  break
    case 'skill':             main.appendChild(skillView(view.recording, view.skill, view.allSkills || []));             break
    case 'agent-running':     main.appendChild(agentRunningView(view.session));                                          break
    case 'agent-bg-running':  main.appendChild(bgAgentRunningView());                                                    break
    case 'agent-cred-review': main.appendChild(agentCredReviewView(view.session, view.creds));                           break
  }

  wrap.appendChild(main)
  if (view.kind === 'idle') wrap.appendChild(bottomNav(view.tab))
  root.appendChild(wrap)
}

// ---- Compact header ----

function compactHeader() {
  const h = document.createElement('header')
  h.style.cssText = 'padding:16px 20px 12px;display:flex;align-items:center;justify-content:space-between;flex-shrink:0;'
  h.innerHTML = `
    <div style="display:flex;align-items:baseline;gap:8px;">
      <span class="display" style="font-size:26px;">SCOUT</span>
      <span class="label" style="font-size:8px;opacity:0.55;">v1.0</span>
    </div>
    <span class="label" style="font-size:8px;opacity:0.38;">Orage AI</span>
  `
  return h
}

// ---- Bottom nav ----

function bottomNav(active) {
  const nav = document.createElement('nav')
  nav.style.cssText = 'display:flex;border-top:1px solid rgba(182,128,57,0.12);background:linear-gradient(0deg,rgba(0,0,0,0.85) 0%,rgba(12,12,12,0.70) 100%);backdrop-filter:blur(20px);flex-shrink:0;'
  const tabs = [
    { id: 'record',   label: 'Record',  icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><circle cx="12" cy="12" r="7"/><circle cx="12" cy="12" r="2.5" fill="currentColor" stroke="none"/></svg>` },
    { id: 'agent',    label: 'Agent',   icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><path d="M12 2L2 7l10 5 10-5-10-5z"/><path d="M2 17l10 5 10-5"/><path d="M2 12l10 5 10-5" stroke-linecap="round"/></svg>` },
    { id: 'macros',   label: 'Macros',  icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><rect x="3" y="6" width="18" height="12" rx="2"/><path d="M7 10h.01M11 10h.01M15 10h.01M7 14h10" stroke-linecap="round"/></svg>` },
    { id: 'monitor',  label: 'Monitor', icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><rect x="2" y="3" width="20" height="14" rx="2"/><path d="M8 21h8M12 17v4" stroke-linecap="round"/></svg>` },
    { id: 'library',  label: 'Library', icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/></svg>` },
    { id: 'settings', label: 'Account', icon: `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor"><circle cx="12" cy="8" r="4"/><path d="M4 20c0-4 3.58-7 8-7s8 3 8 7" stroke-linecap="round"/></svg>` },
  ]
  for (const t of tabs) {
    const btn = document.createElement('button')
    btn.className = `nav-tab${active === t.id ? ' active' : ''}`
    btn.innerHTML = `${t.icon}<span>${t.label}</span>`
    btn.onclick = () => { view = { kind: 'idle', tab: t.id }; render() }
    nav.appendChild(btn)
  }
  return nav
}

// ---- Loading splash ----

function loadingView() {
  const d = document.createElement('div')
  d.style.cssText = 'display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;background:#000;background-image:radial-gradient(ellipse 500px 420px at 105% -10%,rgba(182,128,57,0.13) 0%,transparent 62%),radial-gradient(ellipse 480px 480px at -10% 115%,rgba(228,175,122,0.07) 0%,transparent 62%);'
  d.innerHTML = `
    <div style="font-family:'Bebas Neue',Impact,sans-serif;font-size:52px;letter-spacing:0.05em;color:#E4AF7A;line-height:1;text-transform:uppercase;">SCOUT</div>
    <div style="font-family:'Bebas Neue',sans-serif;font-size:10px;letter-spacing:0.30em;color:rgba(182,128,57,0.55);text-transform:uppercase;margin-top:10px;">By Orage AI</div>
    <div style="margin-top:28px;width:36px;height:2px;background:linear-gradient(90deg,transparent,#B68039,transparent);animation:shimmer 1.4s ease infinite;"></div>
  `
  return d
}

// ---- Auth view (OTP) ----

function authView({ step, email }) {
  const d = document.createElement('div')
  d.style.cssText = 'display:flex;flex-direction:column;align-items:center;justify-content:center;min-height:100vh;padding:32px 24px;background-image:radial-gradient(ellipse 500px 420px at 105% -10%,rgba(182,128,57,0.13) 0%,transparent 62%),radial-gradient(ellipse 480px 480px at -10% 115%,rgba(228,175,122,0.07) 0%,transparent 62%);'

  const logo = document.createElement('div')
  logo.style.cssText = 'text-align:center;margin-bottom:40px;'
  logo.innerHTML = `
    <div style="font-family:'Bebas Neue',Impact,sans-serif;font-size:48px;letter-spacing:0.05em;color:#E4AF7A;line-height:1;">SCOUT</div>
    <div style="font-size:9px;letter-spacing:0.28em;color:rgba(182,128,57,0.55);text-transform:uppercase;margin-top:6px;font-family:'Bebas Neue',sans-serif;">By Orage AI</div>
  `
  d.appendChild(logo)

  const card = document.createElement('div')
  card.className = 'glass'
  card.style.cssText = 'width:100%;max-width:320px;padding:24px;'

  if (step === 'email') {
    card.innerHTML = `
      <div class="display" style="font-size:16px;color:#E4AF7A;margin-bottom:4px;">Sign in</div>
      <p style="font-size:11px;color:rgba(255,232,199,0.45);margin-bottom:20px;line-height:1.6;">We'll send a 6-digit code to your inbox. No password needed.</p>
      <input id="auth-email" type="email" class="input" placeholder="you@orage.agency"
        style="font-size:13px;margin-bottom:12px;width:100%;" />
      <div id="auth-error" style="font-size:11px;color:#F87171;min-height:16px;margin-bottom:8px;"></div>
      <button id="auth-send" class="btn btn-primary" style="width:100%;">Continue →</button>
    `
    const sendOTP = async () => {
      const emailEl = card.querySelector('#auth-email')
      const errEl   = card.querySelector('#auth-error')
      const btn     = card.querySelector('#auth-send')
      const em      = emailEl.value.trim()
      if (!em || !emailEl.checkValidity()) { errEl.textContent = 'Please enter a valid email address.'; return }
      if (!supabase) { errEl.textContent = 'Could not connect to backend. Check your internet connection.'; return }
      btn.textContent = 'Sending…'; btn.disabled = true; errEl.textContent = ''
      const { error } = await supabase.auth.signInWithOtp({ email: em, options: { shouldCreateUser: true } })
      if (error) {
        errEl.textContent = error.message
        btn.disabled = false; btn.textContent = 'Continue →'
        return
      }
      view = { kind: 'auth', step: 'otp', email: em }
      render()
    }
    card.querySelector('#auth-send').onclick = sendOTP
    card.querySelector('#auth-email').addEventListener('keydown', e => { if (e.key === 'Enter') sendOTP() })
    setTimeout(() => card.querySelector('#auth-email').focus(), 60)

  } else {
    card.innerHTML = `
      <div class="display" style="font-size:16px;color:#E4AF7A;margin-bottom:4px;">Check your inbox</div>
      <p style="font-size:11px;color:rgba(255,232,199,0.45);margin-bottom:2px;line-height:1.6;">6-digit code sent to</p>
      <p style="font-size:12px;color:#FFE8C7;font-weight:600;margin-bottom:20px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${escapeHtml(email)}</p>
      <input id="auth-otp" type="text" inputmode="numeric" class="input"
        placeholder="000000" maxlength="6"
        style="font-size:22px;letter-spacing:0.5em;text-align:center;font-family:'JetBrains Mono',monospace;margin-bottom:12px;width:100%;" />
      <div id="auth-error" style="font-size:11px;color:#F87171;min-height:16px;margin-bottom:8px;"></div>
      <button id="auth-verify" class="btn btn-primary" style="width:100%;margin-bottom:8px;">Verify →</button>
      <div style="display:flex;gap:8px;">
        <button id="auth-resend" class="btn" style="flex:1;font-size:11px;">Resend code</button>
        <button id="auth-back"   class="btn" style="flex:1;font-size:11px;">← Change email</button>
      </div>
    `
    const verify = async () => {
      const otpEl = card.querySelector('#auth-otp')
      const errEl = card.querySelector('#auth-error')
      const btn   = card.querySelector('#auth-verify')
      const token = otpEl.value.replace(/\D/g, '')
      if (token.length !== 6) return
      if (!supabase) { errEl.textContent = 'Not connected to backend.'; return }
      btn.textContent = 'Verifying…'; btn.disabled = true; errEl.textContent = ''
      const { data, error } = await supabase.auth.verifyOtp({ email, token, type: 'email' })
      if (error) {
        errEl.textContent = error.message
        btn.disabled = false; btn.textContent = 'Verify →'
        return
      }
      currentUser = data.user
      view = { kind: 'idle', tab: 'record' }
      render()
    }
    const otpInput = card.querySelector('#auth-otp')
    card.querySelector('#auth-verify').onclick = verify
    otpInput.addEventListener('keydown', e => { if (e.key === 'Enter') verify() })
    otpInput.addEventListener('input', e => { if (e.target.value.replace(/\D/g, '').length === 6) verify() })
    card.querySelector('#auth-resend').onclick = async () => {
      const btn = card.querySelector('#auth-resend')
      btn.textContent = 'Sending…'; btn.disabled = true
      await supabase.auth.signInWithOtp({ email, options: { shouldCreateUser: true } })
      btn.textContent = 'Sent ✓'
      setTimeout(() => { btn.textContent = 'Resend code'; btn.disabled = false }, 4000)
    }
    card.querySelector('#auth-back').onclick = () => { view = { kind: 'auth', step: 'email', email }; render() }
    setTimeout(() => card.querySelector('#auth-otp').focus(), 60)
  }

  d.appendChild(card)
  return d
}

// ---- Idle ----

function idleView(tab) {
  if (tab === 'record')   return recordTab()
  if (tab === 'agent')    return agentTab()
  if (tab === 'macros')   return macrosTab()
  if (tab === 'monitor')  return monitorTab()
  if (tab === 'library')  return libraryTab()
  return settingsTab()
}

// ---- Source picker modal ----

function showSourcePickerModal() {
  return new Promise(async (resolve) => {
    const overlay = document.createElement('div')
    overlay.style.cssText = 'position:fixed;inset:0;z-index:9999;background:rgba(0,0,0,0.90);backdrop-filter:blur(8px);display:flex;align-items:center;justify-content:center;padding:20px;'
    overlay.innerHTML = `
      <div class="glass" style="width:100%;padding:20px;display:flex;flex-direction:column;gap:14px;max-height:90vh;">
        <div>
          <div class="display" style="font-size:16px;color:#E4AF7A;">Choose a screen to record</div>
          <p style="font-size:11px;color:rgba(255,232,199,0.45);margin-top:4px;">Select a window or display.</p>
        </div>
        <div id="src-loading" style="font-size:12px;color:rgba(255,232,199,0.40);text-align:center;padding:20px 0;">Loading sources…</div>
        <div id="src-grid" style="display:grid;grid-template-columns:1fr 1fr;gap:8px;overflow-y:auto;max-height:360px;padding-right:2px;display:none;"></div>
        <button id="cancel-picker" class="btn" style="width:100%;font-size:12px;flex-shrink:0;">Cancel</button>
      </div>
    `
    document.body.appendChild(overlay)
    overlay.querySelector('#cancel-picker').onclick = () => { overlay.remove(); resolve(null) }

    let sources
    try { sources = await window.electronAPI.getSources() }
    catch (e) {
      overlay.querySelector('#src-loading').textContent = 'Could not load sources: ' + e.message
      overlay.querySelector('#cancel-picker').onclick = () => { overlay.remove(); resolve(null) }
      return
    }

    overlay.querySelector('#src-loading').style.display = 'none'
    const grid = overlay.querySelector('#src-grid')
    grid.style.display = 'grid'

    for (const src of sources) {
      const card = document.createElement('button')
      card.style.cssText = 'display:flex;flex-direction:column;gap:6px;padding:8px;border-radius:8px;background:rgba(255,255,255,0.04);border:1px solid rgba(182,128,57,0.18);cursor:pointer;transition:all 0.12s ease;text-align:left;'
      const img = document.createElement('img')
      img.src = src.thumbnail
      img.style.cssText = 'width:100%;border-radius:4px;object-fit:cover;aspect-ratio:16/10;background:#0a0a0a;display:block;'
      const label = document.createElement('span')
      label.style.cssText = "font-size:9px;font-family:'Montserrat',sans-serif;color:rgba(255,232,199,0.55);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;width:100%;"
      label.textContent = src.name
      card.appendChild(img); card.appendChild(label)
      card.onmouseenter = () => { card.style.borderColor = 'rgba(182,128,57,0.52)'; card.style.background = 'rgba(182,128,57,0.08)' }
      card.onmouseleave = () => { card.style.borderColor = 'rgba(182,128,57,0.18)'; card.style.background = 'rgba(255,255,255,0.04)' }
      card.onclick = () => { overlay.remove(); resolve(src.id) }
      grid.appendChild(card)
    }
  })
}

// ---- Record tab ----

function recordTab() {
  const d = document.createElement('div')
  d.style.cssText = 'display:flex;flex-direction:column;align-items:center;padding:28px 24px 20px;gap:20px;'

  d.innerHTML = `
    <div style="position:relative;display:flex;align-items:center;justify-content:center;width:140px;height:140px;">
      <div class="record-ring-pulse" style="position:absolute;inset:0;border:1.5px solid rgba(182,128,57,0.28);border-radius:50%;pointer-events:none;"></div>
      <div class="record-ring-pulse-delay" style="position:absolute;inset:0;border:1px solid rgba(182,128,57,0.16);border-radius:50%;pointer-events:none;"></div>
      <div style="position:absolute;inset:-10px;border:1px solid rgba(182,128,57,0.12);border-radius:50%;pointer-events:none;"></div>
      <button id="rec"
        style="position:relative;z-index:2;width:108px;height:108px;border-radius:50%;display:flex;align-items:center;justify-content:center;background:linear-gradient(160deg,#D4924A 0%,#9A6228 55%,#7A4A18 100%);border:1px solid rgba(228,175,122,0.65);box-shadow:0 1px 0 rgba(255,255,255,0.20) inset,0 -2px 0 rgba(0,0,0,0.32) inset,0 10px 40px rgba(182,128,57,0.44);animation:record-btn-idle 3s ease-in-out infinite;cursor:pointer;transition:transform 0.15s;">
        <span style="display:block;width:36px;height:36px;border-radius:50%;background:linear-gradient(180deg,#2a1506 0%,#1a0e02 100%);box-shadow:0 2px 8px rgba(0,0,0,0.60) inset;"></span>
      </button>
    </div>

    <div style="text-align:center;">
      <div class="display" style="font-size:20px;color:#E4AF7A;">Start Recording</div>
      <p id="mode-blurb" style="font-size:12px;line-height:1.65;margin-top:6px;color:rgba(255,232,199,0.50);max-width:240px;margin-inline:auto;"></p>
    </div>

    <div class="glass" style="width:100%;padding:14px 16px;display:flex;flex-direction:column;gap:10px;">
      <div style="display:flex;align-items:center;gap:8px;">
        <span class="label" style="font-size:9px;flex:1;">What are you making?</span>
        <div style="display:flex;gap:4px;">
          <button id="mode-skill"       class="tab-pill" style="font-size:10px;padding:4px 10px;">How-To Guide</button>
          <button id="mode-improvement" class="tab-pill" style="font-size:10px;padding:4px 10px;">Bug Report</button>
        </div>
      </div>
      <div class="divider-subtle"></div>
      <div style="display:flex;align-items:center;gap:8px;">
        <span id="mic-icon" style="font-size:13px;flex-shrink:0;">🎙</span>
        <span style="font-size:12px;flex:1;color:rgba(255,232,199,0.60);">Narrate as you go</span>
        <button id="mic-toggle" class="tab-pill" style="font-size:10px;min-width:36px;padding:4px 10px;">ON</button>
      </div>
    </div>

    <div class="glass" id="how-card" style="width:100%;padding:14px 16px;display:flex;flex-direction:column;gap:8px;border-color:rgba(182,128,57,0.25);">
      <div style="display:flex;align-items:center;justify-content:space-between;">
        <span class="label" style="font-size:9px;">HOW IT WORKS</span>
        <button id="dismiss-hw" style="font-size:16px;line-height:1;background:none;border:none;cursor:pointer;color:rgba(255,232,199,0.35);padding:0 2px;">×</button>
      </div>
      <div style="display:flex;flex-direction:column;gap:6px;">
        <div style="display:flex;align-items:flex-start;gap:8px;"><span style="font-size:13px;flex-shrink:0;">🔴</span><span style="font-size:11px;line-height:1.6;color:rgba(255,232,199,0.65);">Hit record, pick a screen, do your task, narrate as you go.</span></div>
        <div style="display:flex;align-items:flex-start;gap:8px;"><span style="font-size:13px;flex-shrink:0;">✨</span><span style="font-size:11px;line-height:1.6;color:rgba(255,232,199,0.65);">Scout turns your recording into a step-by-step guide your AI can follow.</span></div>
        <div style="display:flex;align-items:flex-start;gap:8px;"><span style="font-size:13px;flex-shrink:0;">📚</span><span style="font-size:11px;line-height:1.6;color:rgba(255,232,199,0.65);">Find all your guides in Library. Download, copy, or use them anytime.</span></div>
      </div>
    </div>
  `

  void getSetting('hw_dismissed', false).then(v => { if (v) d.querySelector('#how-card')?.remove() })
  d.querySelector('#dismiss-hw').onclick = async () => { await setSetting('hw_dismissed', true); d.querySelector('#how-card')?.remove() }

  const micIcon   = d.querySelector('#mic-icon')
  const micToggle = d.querySelector('#mic-toggle')
  void getMicEnabled().then(enabled => {
    micToggle.textContent = enabled ? 'ON' : 'OFF'
    micToggle.className   = `tab-pill${enabled ? ' active' : ''}`
    micToggle.style.cssText = 'font-size:10px;min-width:36px;padding:4px 10px;'
    micIcon.style.opacity = enabled ? '1' : '0.3'
  })
  micToggle.onclick = async () => {
    const next = micToggle.textContent === 'OFF'
    await setSetting('mic_enabled', next)
    micToggle.textContent = next ? 'ON' : 'OFF'
    micToggle.className   = `tab-pill${next ? ' active' : ''}`
    micToggle.style.cssText = 'font-size:10px;min-width:36px;padding:4px 10px;'
    micIcon.style.opacity = next ? '1' : '0.3'
  }

  const modeSkillBtn   = d.querySelector('#mode-skill')
  const modeImproveBtn = d.querySelector('#mode-improvement')
  const blurb          = d.querySelector('#mode-blurb')
  const applyMode = mode => {
    const imp = mode === 'improvement'
    modeSkillBtn.className    = `tab-pill${!imp ? ' active' : ''}`
    modeSkillBtn.style.cssText  = 'font-size:10px;padding:4px 10px;'
    modeImproveBtn.className  = `tab-pill${imp ? ' active' : ''}`
    modeImproveBtn.style.cssText = 'font-size:10px;padding:4px 10px;'
    blurb.textContent = imp
      ? "Show what's broken or confusing. Scout will write a clear report your team can act on."
      : 'Do the task as you normally would. Scout will turn your recording into a step-by-step guide.'
  }
  void getRecordingMode().then(applyMode)
  modeSkillBtn.onclick   = async () => { await setSetting('recording_mode', 'skill');       applyMode('skill') }
  modeImproveBtn.onclick = async () => { await setSetting('recording_mode', 'improvement'); applyMode('improvement') }

  const recBtn = d.querySelector('#rec')
  if (recBtn) recBtn.onclick = (ev) => { ev.preventDefault(); void startRecording() }
  return d
}

// ---- Start recording ----

async function startRecording() {
  const mode = await getRecordingMode()

  // No-friction: auto-pick the primary screen instead of showing a picker.
  let primaryScreen = null
  try {
    const sources = await window.electronAPI.getSources()
    primaryScreen = (sources || []).find(s => /^screen:/.test(s.id)) || (sources || [])[0]
  } catch (e) { console.warn('[REC] getSources failed:', e) }
  if (!primaryScreen) { alert("Scout couldn't find a screen to record."); return }
  await window.electronAPI.setSelectedSource(primaryScreen.id)

  let screenStream
  try {
    screenStream = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })
  } catch (e) { console.error('Screen capture failed:', e); return }

  // No-friction: always try mic. If denied at OS level, recording continues without it.
  let micStream = null
  try { micStream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true } }) }
  catch (e) { console.warn('Mic unavailable:', e) }

  // Audio-only recorder — what we actually upload for transcription. Smaller,
  // valid for Anthropic's audio document input, no 500s from huge video.
  let audioRecorder = null, audioChunks = []
  if (micStream && micStream.getAudioTracks().length > 0) {
    const audioOnly = new MediaStream(micStream.getAudioTracks())
    const mimeAudio = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : 'audio/webm'
    try {
      audioRecorder = new MediaRecorder(audioOnly, { mimeType: mimeAudio })
      audioRecorder.ondataavailable = e => { if (e.data?.size > 0) audioChunks.push(e.data) }
      audioRecorder.start(5000)
    } catch (e) { console.warn('[REC] audio-only recorder failed:', e); audioRecorder = null }
  }

  // Combined recorder — kept for archival / future video features.
  const tracks   = [...screenStream.getVideoTracks(), ...(micStream ? micStream.getAudioTracks() : [])]
  const combined = new MediaStream(tracks)
  const mimeType = MediaRecorder.isTypeSupported('video/webm;codecs=vp9,opus') ? 'video/webm;codecs=vp9,opus' : 'video/webm'
  const recorder = new MediaRecorder(combined, { mimeType })
  const chunks   = []
  recorder.ondataavailable = e => { if (e.data.size > 0) chunks.push(e.data) }
  recorder.start(5000)

  // Live keyframe capture — grab JPEG frames straight off the screen stream
  // while recording. Post-hoc extraction from the recorded blob is unreliable:
  // MediaRecorder webm is often unseekable, and when a mic is present the
  // uploaded blob is audio-only. These frames are the visual evidence the
  // local skill generator feeds to Claude.
  const liveFrames = []
  const frameVideo = document.createElement('video')
  frameVideo.muted = true
  frameVideo.srcObject = screenStream
  void frameVideo.play().catch(() => {})
  const frameCanvas = document.createElement('canvas')
  const grabFrame = () => {
    try {
      if (!frameVideo.videoWidth) return
      const scale = Math.min(1, 1280 / frameVideo.videoWidth)
      frameCanvas.width  = Math.round(frameVideo.videoWidth * scale)
      frameCanvas.height = Math.round(frameVideo.videoHeight * scale)
      frameCanvas.getContext('2d').drawImage(frameVideo, 0, 0, frameCanvas.width, frameCanvas.height)
      liveFrames.push(frameCanvas.toDataURL('image/jpeg', 0.7).split(',')[1])
      // Cap the set: drop from the middle so first and latest survive.
      if (liveFrames.length > 8) liveFrames.splice(2, 2)
    } catch {}
  }
  const frameTimer = setInterval(grabFrame, 4000)
  setTimeout(grabFrame, 700)   // early frame so short recordings get at least one

  view = {
    kind: 'recording',
    state: {
      recording_id: crypto.randomUUID(),
      started_at:   Date.now(),
      paused_ms:    0,
      is_paused:    false,
      mic_enabled:     !!micStream,
      audio_supported: !!micStream,
      mode,
      live_transcript: '',
      coach_ask_count: 0,
      _chunkRecorder:  null,
      _coachInterval:  null,
      _speechRec:      null,
      _recorder: recorder, _chunks: chunks,
      _audioRecorder: audioRecorder, _audioChunks: audioChunks,
      _screenStream: screenStream, _micStream: micStream,
      _frames: liveFrames, _frameTimer: frameTimer, _frameVideo: frameVideo, _grabFrame: grabFrame,
      window_at_start: null,
      window_at_end:   null,
    },
  }
  view.state._speechRec = startSpeechRecognition()

  // Screen context — capture which app/window was focused at recording start
  // so the generated .md can name the route ("In Notion, the Settings page…").
  // Snapshot a moment after start so the user's own click on Scout's record
  // button isn't what we capture as "the focused window".
  setTimeout(async () => {
    try {
      const w = await window.electronAPI.getActiveWindowInfo?.()
      if (w && view.kind === 'recording') view.state.window_at_start = w
    } catch {}
  }, 800)

  // Insert the recording row up front so screenshot events can FK-reference it.
  // Status starts as 'recording' and is updated on stop.
  if (supabase && currentUser) {
    try {
      const { error: pre } = await supabase.from('recordings').insert({
        id:           view.state.recording_id,
        user_id:      currentUser.id,
        title:        'Recording',
        status:       'recording',
        started_at:   new Date(view.state.started_at).toISOString(),
        mode,
        transcript:   { segments: [] },
        meta:         { platform: window.electronAPI.platform, ua: navigator.userAgent },
      })
      if (pre) console.warn('[REC] pre-insert recording row failed:', pre.message)
    } catch (e) { console.warn('[REC] pre-insert threw:', e) }
  }
  startScreenshotLoop(screenStream, view.state.recording_id)

  screenStream.getVideoTracks()[0].addEventListener('ended', () => {
    if (view.kind === 'recording') void doStopRecording()
  })

  if (micStream) startChunkLoop(micStream, view.state.recording_id)
  startCoachLoop(view.state.recording_id)
  void window.electronAPI.overlayShow?.({ startedAt: view.state.started_at })

  render()
}

// ---- Stop recording ----

async function doStopRecording() {
  if (view.kind !== 'recording') return
  const { _recorder, _chunks, _audioRecorder, _audioChunks, _screenStream, _micStream, _frames, _frameTimer, _frameVideo, _grabFrame, recording_id, started_at, paused_ms, mode, window_at_start } = view.state

  // Capture the focused window NOW (before we steal focus by tearing down
  // streams) so the skill prompt can note where the user finished.
  let window_at_end = null
  try { window_at_end = await window.electronAPI.getActiveWindowInfo?.() } catch {}

  // One last frame of the final screen state, then stop the live capture.
  try { _grabFrame?.() } catch {}
  if (_frameTimer) clearInterval(_frameTimer)
  if (_frameVideo) _frameVideo.srcObject = null

  stopRecordingLoops()
  void window.electronAPI.overlayHide?.()
  _screenStream?.getTracks().forEach(t => t.stop())
  _micStream?.getTracks().forEach(t => t.stop())

  await new Promise(resolve => {
    _recorder.onstop = resolve
    if (_recorder.state !== 'inactive') _recorder.stop()
  })

  let audioBlob = null
  if (_audioRecorder) {
    await new Promise(resolve => {
      _audioRecorder.onstop = resolve
      if (_audioRecorder.state !== 'inactive') _audioRecorder.stop()
    })
    if (_audioChunks.length > 0) audioBlob = new Blob(_audioChunks, { type: 'audio/webm' })
  }

  const duration = Date.now() - started_at - (paused_ms || 0)

  const rec = {
    id:          recording_id,
    title:       'New recording',
    status:      'ready',
    started_at:  new Date(started_at).toISOString(),
    duration_ms: duration,
    mode,
    transcript:  { segments: [] },
    skills:      [],
    // Prefer the audio-only blob for upload; falls back to combined webm.
    _blob:       audioBlob || new Blob(_chunks, { type: 'video/webm' }),
    _isAudioOnly: !!audioBlob,
    _frames:     _frames || [],
    _speechTranscript: view.state.live_transcript || '',
    _window_at_start: window_at_start || null,
    _window_at_end:   window_at_end   || null,
  }

  // No-friction: skip the extra_context step. Auto-generate skill.
  void processRecording(rec)
}

// Build a small text block describing where the user was on screen during
// recording. Fed to generate-skill via the existing `extra` field so the
// edge function (which already concatenates `extra` into its system prompt)
// surfaces it to Claude without any backend changes.
function buildScreenContext(rec) {
  const lines = []
  const fmt = (w) => w && (w.app || w.title) ? `${w.app || 'unknown app'} — "${w.title || ''}"` : null
  const start = fmt(rec._window_at_start)
  const end   = fmt(rec._window_at_end)
  if (start) lines.push(`- Focused app at recording start: ${start}`)
  if (end && end !== start) lines.push(`- Focused app at recording end:   ${end}`)
  if (!lines.length) return ''
  return [
    'Screen context (auto-captured by Scout):',
    ...lines,
    `- Platform: ${PLATFORM.label}`,
    'Use these to mention the app/route in the skill title and steps when relevant.',
  ].join('\n')
}

// ---- Screenshot loop (sample frames from the screen stream → screenshots bucket) ----

function startScreenshotLoop(screenStream, recording_id) {
  if (!screenStream || !supabase || !currentUser) return
  const video = document.createElement('video')
  video.srcObject = screenStream
  video.muted = true
  video.playsInline = true
  void video.play().catch(() => {})

  const canvas = document.createElement('canvas')
  const ctx    = canvas.getContext('2d')

  const tick = async () => {
    if (view.kind !== 'recording') return
    if (view.state.is_paused)      { setTimeout(tick, 1500); return }

    try {
      const vw = video.videoWidth, vh = video.videoHeight
      if (vw > 0 && vh > 0) {
        const w = 960
        const h = Math.round(w * vh / vw)
        canvas.width = w; canvas.height = h
        ctx.drawImage(video, 0, 0, w, h)
        const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', 0.72))
        if (blob && view.kind === 'recording') {
          const ts_ms   = Date.now() - view.state.started_at
          const eventId = (crypto.randomUUID ? crypto.randomUUID() : ('e-' + Date.now()))
          const path    = `${currentUser.id}/${recording_id}/${eventId}.jpg`
          try {
            const up = await supabase.storage.from('screenshots').upload(path, blob, { contentType: 'image/jpeg', upsert: false })
            if (!up.error) {
              await supabase.from('events').insert({
                recording_id, user_id: currentUser.id, ts_ms,
                kind: 'screenshot', data: {}, screenshot_path: path,
              })
            }
          } catch (e) { console.warn('[shot] upload/insert failed:', e) }
        }
      }
    } catch (e) { console.warn('[shot] tick error:', e) }

    if (view.kind === 'recording') setTimeout(tick, 5000)
  }
  setTimeout(tick, 1200) // first capture after a beat so video has actual frames
}

// ---- Native Web Speech transcription (free, no API key, runs in renderer) ----

function startSpeechRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition
  if (!SR) { console.warn('[SR] SpeechRecognition not available in this Electron build'); return null }
  let rec
  try { rec = new SR() } catch (e) { console.warn('[SR] constructor failed:', e); return null }
  rec.continuous     = true
  rec.interimResults = true
  rec.lang           = navigator.language || 'en-US'
  rec.onresult = (event) => {
    if (view.kind !== 'recording') return
    let appended = false
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const r = event.results[i]
      if (r.isFinal) {
        const text = (r[0]?.transcript || '').trim()
        if (text) {
          view.state.live_transcript = (view.state.live_transcript ? view.state.live_transcript + ' ' : '') + text
          appended = true
        }
      }
    }
    if (appended) {
      const el = document.getElementById('live-transcript')
      if (el) { el.textContent = view.state.live_transcript; el.scrollTop = el.scrollHeight }
    }
  }
  let dead = false
  rec.onerror = (e) => {
    const err = e?.error || String(e)
    console.warn('[SR] error:', err)
    // network / not-allowed / service-not-allowed are fatal in Electron — Google
    // removed public Web Speech endpoint, so the underlying transport can't connect.
    // Stop retrying so we don't spam logs every 50 ms.
    if (err === 'network' || err === 'not-allowed' || err === 'service-not-allowed' || err === 'aborted') {
      dead = true
      try { rec.onend = null; rec.stop() } catch {}
    }
  }
  rec.onend = () => {
    if (dead) return
    if (view.kind === 'recording' && !view.state.is_paused) {
      try { rec.start() } catch (e) { /* already started or permission denied */ }
    }
  }
  try { rec.start(); console.log('[SR] started') } catch (e) { console.warn('[SR] start failed:', e); return null }
  return rec
}

// ---- Live transcription (chunks every ~5s while recording) ----

async function dispatchChunk(blob, recording_id) {
  if (!blob || blob.size < 2000) return
  try {
    const buf = await blob.arrayBuffer()
    let s = ''
    const bytes = new Uint8Array(buf)
    for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i])
    const b64 = btoa(s)
    const res = await fetch(`${SUPABASE_URL}/functions/v1/transcribe-chunk`, {
      method:  'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
      body:    JSON.stringify({ audio_base64: b64, mime_type: 'audio/webm', recording_id }),
    })
    const json = await res.json().catch(() => ({}))
    const text = (json.text || '').trim()
    if (text && view.kind === 'recording') {
      view.state.live_transcript = (view.state.live_transcript ? view.state.live_transcript + ' ' : '') + text
      const el = document.getElementById('live-transcript')
      if (el) { el.textContent = view.state.live_transcript; el.scrollTop = el.scrollHeight }
    }
  } catch (e) { console.warn('[chunk] transcribe failed', e) }
}

function startChunkLoop(micStream, recording_id) {
  if (!micStream || micStream.getAudioTracks().length === 0) return
  const audioOnly = new MediaStream(micStream.getAudioTracks())
  const tick = () => {
    if (view.kind !== 'recording') return
    if (view.state.is_paused) { setTimeout(tick, 1500); return }
    const localChunks = []
    let rec
    try { rec = new MediaRecorder(audioOnly, { mimeType: 'audio/webm;codecs=opus' }) }
    catch { try { rec = new MediaRecorder(audioOnly) } catch { return } }
    rec.ondataavailable = e => { if (e.data?.size > 0) localChunks.push(e.data) }
    rec.onstop = () => {
      const blob = new Blob(localChunks, { type: 'audio/webm' })
      void dispatchChunk(blob, recording_id)
      if (view.kind === 'recording') setTimeout(tick, 100)
    }
    try { rec.start() } catch { return }
    view.state._chunkRecorder = rec
    setTimeout(() => { try { if (rec.state !== 'inactive') rec.stop() } catch {} }, 5000)
  }
  tick()
}

// ---- Coach polling (every 30s while recording) ----

function startCoachLoop(recording_id) {
  const interval = setInterval(async () => {
    if (view.kind !== 'recording') { clearInterval(interval); return }
    if (view.state.is_paused) return
    const tail = (view.state.live_transcript || '').slice(-1500)
    const askCount = view.state.coach_ask_count || 0
    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/coach`, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${SUPABASE_ANON_KEY}` },
        body:    JSON.stringify({ events: [], transcript_tail: tail, ask_count: askCount, current_url: null, current_title: null }),
      })
      const json = await res.json().catch(() => ({ ask: null }))
      const ask = json.ask
      if (ask && view.kind === 'recording') {
        view.state.coach_ask_count = askCount + 1
        const asked_at_ms = Date.now() - view.state.started_at
        showCoachToast(ask, recording_id, asked_at_ms)
        if (supabase) {
          try { await supabase.from('coach_log').insert({ recording_id, asked_at_ms, ask_text: ask }) }
          catch (e) { console.warn('[coach] log insert failed', e) }
        }
      }
    } catch (e) { console.warn('[coach] poll failed', e) }
  }, 30000)
  view.state._coachInterval = interval
}

function showCoachToast(ask, recording_id, asked_at_ms) {
  const existing = document.getElementById('coach-toast')
  if (existing) existing.remove()
  const toast = document.createElement('div')
  toast.id = 'coach-toast'
  toast.style.cssText = 'position:fixed;top:14px;left:14px;right:14px;background:rgba(20,12,4,0.95);border:1px solid rgba(228,175,122,0.45);border-radius:8px;padding:14px;z-index:9999;box-shadow:0 4px 24px rgba(0,0,0,0.55);backdrop-filter:blur(12px);font-family:-apple-system,Segoe UI,sans-serif;'
  const safe = String(ask).replace(/[<>&"]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;' }[c]))
  toast.innerHTML = `
    <div style="font-family:'Bebas Neue',sans-serif;font-size:9px;letter-spacing:0.14em;text-transform:uppercase;color:#E4AF7A;margin-bottom:6px;">Coach asks</div>
    <div style="font-size:13px;color:#FFE8C7;line-height:1.4;margin-bottom:10px;">${safe}</div>
    <div style="display:flex;gap:6px;">
      <input id="ct-reply" type="text" placeholder="Type a quick answer..." style="flex:1;background:rgba(0,0,0,0.4);border:1px solid rgba(228,175,122,0.25);border-radius:4px;padding:6px 8px;font-size:12px;color:#FFE8C7;outline:none;font-family:inherit;" />
      <button id="ct-skip" style="background:none;border:1px solid rgba(255,255,255,0.15);color:rgba(255,232,199,0.5);border-radius:4px;padding:6px 10px;font-size:11px;cursor:pointer;font-family:inherit;">skip</button>
    </div>
  `
  document.body.appendChild(toast)
  const input = toast.querySelector('#ct-reply')
  const close = () => { try { toast.remove() } catch {} }
  toast.querySelector('#ct-skip').onclick = close
  input.onkeydown = async (e) => {
    if (e.key !== 'Enter') return
    const reply = input.value.trim()
    close()
    if (reply && supabase) {
      try { await supabase.from('coach_log').update({ reply_transcript: reply }).eq('recording_id', recording_id).eq('asked_at_ms', asked_at_ms) }
      catch (err) { console.warn('[coach] reply update failed', err) }
    }
  }
  setTimeout(() => input?.focus(), 50)
  setTimeout(close, 25000)
}

function stopRecordingLoops() {
  if (view.kind !== 'recording') return
  try { if (view.state._chunkRecorder && view.state._chunkRecorder.state !== 'inactive') view.state._chunkRecorder.stop() } catch {}
  if (view.state._coachInterval) { clearInterval(view.state._coachInterval); view.state._coachInterval = null }
  if (view.state._speechRec) {
    try { view.state._speechRec.onend = null; view.state._speechRec.stop() } catch {}
    view.state._speechRec = null
  }
  const t = document.getElementById('coach-toast'); if (t) t.remove()
}

// ---- Recording view ----

function recordingView(s) {
  const d = document.createElement('div')
  d.style.cssText = 'padding:20px;display:flex;flex-direction:column;gap:16px;'

  const audioBadge = s.mic_enabled && s.audio_supported
    ? `<span style="display:inline-flex;align-items:center;gap:4px;font-family:'Bebas Neue',sans-serif;font-size:9px;letter-spacing:0.14em;text-transform:uppercase;color:#4ADE80;"><span style="width:6px;height:6px;border-radius:50%;background:#4ADE80;animation:pulse-dot 1.6s ease-in-out infinite;display:inline-block;"></span>MIC LIVE</span>`
    : s.mic_enabled
    ? `<span class="badge badge-orange">🎙 denied</span>`
    : `<span class="badge badge-muted">🎙 off</span>`

  d.innerHTML = `
    <div class="glass-hero" style="padding:20px;text-align:center;">
      <div style="display:flex;align-items:center;justify-content:center;gap:10px;margin-bottom:12px;">
        <span class="record-dot"></span>
        <span class="display" style="font-size:13px;color:#E4AF7A;">${s.mode === 'improvement' ? 'Critiquing' : 'Recording'}</span>
        ${audioBadge}
      </div>
      <div id="t" class="display" style="font-size:54px;color:#FFE8C7;letter-spacing:0.04em;font-variant-numeric:tabular-nums;">00:00</div>
      <div style="font-size:11px;margin-top:8px;color:rgba(255,232,199,0.45);">capturing your screen</div>
    </div>

    <div style="display:flex;gap:8px;">
      <button id="pause" class="btn" style="flex:1;">${s.is_paused ? 'Resume' : 'Pause'}</button>
      <button id="stop"  class="btn btn-primary" style="flex:1;">Stop & Generate</button>
    </div>
    <button id="discard" class="btn" style="width:100%;color:rgba(239,68,68,0.75);border-color:rgba(239,68,68,0.30);font-size:11px;">Cancel recording</button>

    <div class="glass" style="padding:12px;max-height:180px;display:flex;flex-direction:column;gap:6px;">
      <div style="display:flex;align-items:center;justify-content:space-between;">
        <div class="label" style="font-size:8px;">Live transcript</div>
        <div style="font-size:8px;letter-spacing:0.10em;color:rgba(228,175,122,0.40);text-transform:uppercase;">${s.mic_enabled && s.audio_supported ? 'listening' : 'mic off'}</div>
      </div>
      <div id="live-transcript" style="font-size:11px;line-height:1.6;color:rgba(255,232,199,0.65);overflow-y:auto;flex:1;min-height:40px;max-height:140px;">${(s.live_transcript || '').replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c])) || '<span style="color:rgba(255,232,199,0.25);">Say something — it will appear here within ~5s…</span>'}</div>
    </div>
  `

  const startedMs = s.started_at
  const tEl = d.querySelector('#t')
  const timerInterval = setInterval(() => {
    if (view.kind !== 'recording') { clearInterval(timerInterval); return }
    if (view.state.is_paused) return
    const ms  = Math.max(0, Date.now() - startedMs - (view.state.paused_ms ?? 0))
    const sec = Math.floor(ms / 1000) % 60
    const min = Math.floor(ms / 60000)
    tEl.textContent = `${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`
  }, 500)

  const tipInterval = null  // tips replaced by live transcript pane

  d.querySelector('#pause').onclick = () => {
    view.state.is_paused = !view.state.is_paused
    if (view.state._recorder?.state === 'recording') view.state._recorder.pause()
    else if (view.state._recorder?.state === 'paused') view.state._recorder.resume()
    render()
  }

  d.querySelector('#stop').onclick = async () => {
    clearInterval(timerInterval)
    await doStopRecording()
  }

  let discardConfirming = false
  const discardBtn = d.querySelector('#discard')
  discardBtn.onclick = () => {
    if (!discardConfirming) {
      discardConfirming = true
      discardBtn.textContent = 'Tap again to confirm'
      setTimeout(() => { discardConfirming = false; discardBtn.textContent = 'Cancel recording' }, 3000)
    } else {
      clearInterval(timerInterval)
      stopRecordingLoops()
      void window.electronAPI.overlayHide?.()
      view.state._screenStream?.getTracks().forEach(t => t.stop())
      view.state._micStream?.getTracks().forEach(t => t.stop())
      if (view.state._recorder?.state !== 'inactive') view.state._recorder?.stop()
      view = { kind: 'idle', tab: 'record' }
      render()
    }
  }

  return d
}

// ---- Extra context view ----

function extraContextView(rec) {
  const d = document.createElement('div')
  d.style.cssText = 'padding:20px;display:flex;flex-direction:column;gap:12px;'

  const dur        = rec.duration_ms ? `${Math.round(rec.duration_ms / 1000)}s` : ''
  const canGenerate = !!(supabase && currentUser)
  const primaryLabel   = canGenerate ? 'Generate Skill ✦' : 'Save to disk'
  const secondaryLabel = canGenerate ? 'Discard recording' : 'Discard'
  const infoText = canGenerate
    ? 'Scout will upload your recording, transcribe the narration, then generate a SKILL.md using Claude.'
    : 'Sign in on the Account tab to enable automatic skill generation. The recording will be discarded if you continue.'

  d.innerHTML = `
    <div class="glass" style="padding:20px;display:flex;flex-direction:column;gap:12px;">
      <div>
        <div class="display" style="font-size:18px;">Anything else to add?</div>
        ${dur ? `<div style="font-size:10px;margin-top:4px;color:rgba(255,232,199,0.40);">${dur} recorded</div>` : ''}
      </div>
      <p style="font-size:12px;line-height:1.65;color:rgba(255,232,199,0.60);">
        Any context that's hard to see on screen — a rule, an exception, a reason you chose one option over another.
      </p>
      <textarea id="ec" class="input" rows="4"
        placeholder="e.g. We always pick the earliest delivery date for California — it's a legal thing."
        style="resize:vertical;min-height:80px;"></textarea>
      <div style="display:flex;gap:8px;">
        <button id="ec-save" class="btn btn-primary" style="flex:1;">${primaryLabel}</button>
        <button id="ec-skip" class="btn"             style="flex:1;">${secondaryLabel}</button>
      </div>
    </div>
    <div class="glass" style="padding:12px;display:flex;align-items:start;gap:10px;border-color:rgba(182,128,57,0.15);">
      <span style="color:#B68039;font-size:13px;flex-shrink:0;margin-top:1px;">ⓘ</span>
      <div style="font-size:11px;line-height:1.6;color:rgba(255,232,199,0.45);">${infoText}</div>
    </div>
  `

  d.querySelector('#ec-save').onclick = async () => {
    const extra = d.querySelector('#ec').value.trim()
    if (canGenerate) {
      await processRecording(rec, extra)
    } else {
      view = { kind: 'idle', tab: 'library' }
      render()
    }
  }
  d.querySelector('#ec-skip').onclick = () => {
    if (canGenerate && rec._blob) {
      if (!confirm('Discard this recording? It will not be saved.')) return
    }
    view = { kind: 'idle', tab: 'library' }
    render()
  }
  setTimeout(() => d.querySelector('#ec').focus(), 50)
  return d
}

// ---- Processing view ----

function processingView(rec, stage, error) {
  const d = document.createElement('div')
  d.style.cssText = 'padding:20px;display:flex;flex-direction:column;gap:16px;'

  const stages = [
    { id: 'uploading',    label: 'Uploading',    sub: 'audio + metadata' },
    { id: 'transcribing', label: 'Transcribing', sub: 'voice narration' },
    { id: 'drafting',     label: 'Drafting',     sub: rec.mode === 'improvement' ? 'improvement brief' : 'skill file' },
  ]
  const currentIdx = stages.findIndex(s => s.id === stage)
  const pct = stage === 'uploading' ? 18 : stage === 'transcribing' ? 52 : 80
  const stepsHtml = stages.map((s, i) => {
    const done = i < currentIdx, active = i === currentIdx
    const dot  = done ? 'step-dot done' : active ? 'step-dot active' : 'step-dot pending'
    return `<div class="step-row"><span class="${dot}"></span><div><div style="font-size:13px;color:${done?'rgba(255,232,199,0.65)':active?'#FFE8C7':'rgba(255,232,199,0.28)'};font-weight:600;">${s.label}</div><div style="font-size:10px;color:${active?'rgba(255,232,199,0.50)':'rgba(255,232,199,0.20)'};">${s.sub}</div></div></div>`
  }).join('')

  const liveBlock = (!error && stage === 'drafting') ? `
    <div style="margin-top:14px;padding-top:14px;border-top:1px solid rgba(182,128,57,0.12);">
      <div class="label" style="font-size:8px;margin-bottom:6px;">GENERATING</div>
      <div id="live-skill-text" style="font-size:10px;line-height:1.6;color:rgba(255,232,199,0.38);font-family:'JetBrains Mono',monospace;white-space:pre-wrap;word-break:break-word;max-height:110px;overflow-y:auto;"></div>
    </div>` : ''

  d.innerHTML = `
    <div class="glass" style="padding:20px;">
      <div style="display:flex;align-items:start;justify-content:space-between;margin-bottom:4px;">
        <div class="display" style="font-size:18px;">${error ? 'Something went wrong' : 'Building your skill'}</div>
        ${!error ? `<span style="font-size:11px;color:rgba(255,232,199,0.35);">${pct}%</span>` : ''}
      </div>
      <div style="font-size:11px;margin-bottom:12px;color:rgba(255,232,199,0.45);">${rec.duration_ms ? Math.round(rec.duration_ms/1000)+'s recording' : 'Processing'} · usually 30–60s</div>
      ${!error ? `<div style="height:2px;background:rgba(255,255,255,0.05);border-radius:1px;margin-bottom:16px;overflow:hidden;"><div style="height:100%;width:${pct}%;background:linear-gradient(90deg,#9A6228,#E4AF7A);border-radius:1px;transition:width 0.6s ease;"></div></div>` : ''}
      ${error
        ? `<div class="glass-strong" style="padding:12px;margin-bottom:12px;border-radius:8px;"><p style="font-size:12px;color:#F87171;margin-bottom:12px;">${escapeHtml(error)}</p><button id="proc-back" class="btn" style="font-size:11px;width:100%;">← Back to Library</button></div>`
        : stepsHtml}
      ${liveBlock}
    </div>
  `
  if (error) d.querySelector('#proc-back').onclick = () => { view = { kind: 'idle', tab: 'library' }; render() }
  return d
}

// ---- Library tab ----

function libraryTab() {
  const d = document.createElement('div')
  d.style.cssText = 'display:flex;flex-direction:column;padding:16px 20px;flex:1;'

  const searchWrap = document.createElement('div')
  searchWrap.style.marginBottom = '8px'
  searchWrap.innerHTML = `
    <div style="position:relative;">
      <span style="position:absolute;left:10px;top:50%;transform:translateY(-50%);pointer-events:none;opacity:0.38;">
        <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="#FFD69C" stroke-width="2"><circle cx="11" cy="11" r="7"/><path d="M21 21l-4.35-4.35" stroke-linecap="round"/></svg>
      </span>
      <input id="search" type="text" placeholder="Search recordings and skills…" class="input" style="padding-left:30px;font-size:12px;" />
    </div>`
  d.appendChild(searchWrap)

  const controlBar = document.createElement('div')
  controlBar.style.cssText = 'display:flex;align-items:center;justify-content:space-between;margin-bottom:8px;'
  controlBar.innerHTML = `
    <span id="lib-stats" style="font-size:10px;color:rgba(255,232,199,0.28);">Loading…</span>
    <div style="display:flex;gap:4px;">
      <button data-sort="newest"     class="tab-pill active" style="font-size:9px;padding:3px 7px;">Newest</button>
      <button data-sort="oldest"     class="tab-pill"        style="font-size:9px;padding:3px 7px;">Oldest</button>
      <button data-sort="most-skills" class="tab-pill"       style="font-size:9px;padding:3px 7px;">Most</button>
    </div>`
  d.appendChild(controlBar)

  const list = document.createElement('div')
  list.id = 'list'
  list.style.cssText = 'display:flex;flex-direction:column;gap:8px;flex:1;'
  d.appendChild(list)

  let allRecordings = [], currentSort = 'newest'
  const getSorted = () => {
    const copy = [...allRecordings]
    if (currentSort === 'oldest') return copy.reverse()
    if (currentSort === 'most-skills') return copy.sort((a, b) => (b.skills?.length ?? 0) - (a.skills?.length ?? 0))
    return copy
  }
  const renderList = query => {
    const words    = query.toLowerCase().trim().split(/\s+/).filter(Boolean)
    const sorted   = getSorted()
    const filtered = words.length ? sorted.filter(r => {
      const hay = [r.title ?? '', ...(r.skills ?? []).map(s => s.body_md ?? '')].join(' ').toLowerCase()
      return words.every(w => hay.includes(w))
    }) : sorted
    renderCards(list, filtered, query)
  }

  searchWrap.querySelector('#search').oninput = e => renderList(e.target.value)
  controlBar.querySelectorAll('[data-sort]').forEach(btn => {
    btn.onclick = () => {
      currentSort = btn.getAttribute('data-sort')
      controlBar.querySelectorAll('[data-sort]').forEach(b => {
        b.className = `tab-pill${b === btn ? ' active' : ''}`
        b.style.cssText = 'font-size:9px;padding:3px 7px;'
      })
      renderList(searchWrap.querySelector('#search').value)
    }
  })

  void loadLibraryData().then(data => {
    if (!data) return
    allRecordings = data
    const total = allRecordings.reduce((n, r) => n + (r.skills?.length ?? 0), 0)
    const sampleBadge = !currentUser ? '<span style="color:rgba(255,232,199,0.28);"> · sample data</span>' : ''
    controlBar.querySelector('#lib-stats').innerHTML = `${allRecordings.length} recording${allRecordings.length !== 1 ? 's' : ''} · ${total} skill${total !== 1 ? 's' : ''}${sampleBadge}`
    renderCards(list, allRecordings, '')
  })

  return d
}

function renderCards(container, rows, query) {
  container.innerHTML = ''
  if (!rows.length) {
    container.innerHTML = query
      ? `<div class="glass" style="padding:20px;margin-top:8px;text-align:center;"><div class="display" style="font-size:13px;margin-bottom:4px;">No results</div><p style="font-size:11px;color:rgba(255,232,199,0.40);">Nothing matched <strong style="color:#E4AF7A;">"${escapeHtml(query)}"</strong></p></div>`
      : `<div class="glass" style="padding:24px;text-align:center;"><div class="display" style="font-size:15px;color:#E4AF7A;margin-bottom:8px;">Your first skill is 3 clicks away.</div><p style="font-size:12px;color:rgba(255,232,199,0.45);">Hit Record, do your task, stop. Scout does the rest.</p></div>`
    return
  }
  for (const r of rows) {
    const card    = document.createElement('button')
    card.className = 'glass library-card'
    card.style.cssText = 'width:100%;padding:12px 14px;cursor:pointer;text-align:left;'
    const title     = r.title || 'Untitled recording'
    const date      = new Date(r.started_at).toLocaleString(undefined, { month:'short', day:'numeric', hour:'numeric', minute:'2-digit' })
    const dur       = r.duration_ms ? `${Math.round(r.duration_ms/1000)}s` : '—'
    const hasSkill  = (r.skills?.length ?? 0) > 0
    const maxVer    = hasSkill ? Math.max(...r.skills.map(s => s.version ?? 1)) : 1
    const kinds     = new Set((r.skills ?? []).map(s => s.kind ?? 'skill'))
    const kindBadge = r.mode === 'improvement' ? `<span class="badge badge-orange" style="margin-left:4px;">brief</span>` : ''
    const skillBadge = hasSkill ? `<span class="badge badge-gold">✦ Skill${maxVer > 1 ? ` · v${maxVer}` : ''}</span>` : ''
    const primary = (r.skills ?? []).find(s => (s.kind ?? 'skill') === 'skill') ?? (r.skills ?? [])[0]
    let excerpt = ''
    if (primary?.body_md) {
      const { body } = splitFrontmatter(primary.body_md)
      excerpt = body.replace(/^#+\s+.*/gm,'').replace(/\*\*/g,'').replace(/\n+/g,' ').trim().slice(0, 90)
    }
    card.innerHTML = `
      <div style="display:flex;align-items:flex-start;gap:10px;">
        <div style="flex:1;min-width:0;">
          <div style="display:flex;align-items:center;gap:6px;flex-wrap:wrap;">
            <span style="font-size:13px;font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#FFE8C7;">${escapeHtml(title)}</span>${kindBadge}
          </div>
          <div style="display:flex;align-items:center;gap:8px;margin-top:4px;">
            <span style="font-size:10px;color:rgba(255,232,199,0.38);">${escapeHtml(date)} · ${dur}</span>${skillBadge}
          </div>
          ${excerpt ? `<div style="font-size:10px;margin-top:6px;line-height:1.5;color:rgba(255,232,199,0.30);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(excerpt)}…</div>` : ''}
        </div>
        <span class="${statusColor(r.status)}" style="font-family:'Bebas Neue',sans-serif;font-size:9px;letter-spacing:0.18em;text-transform:uppercase;flex-shrink:0;">${r.status}</span>
      </div>`
    card.onclick = () => {
      const sorted  = [...(r.skills ?? [])].sort((a, b) => (b.version ?? 1) - (a.version ?? 1))
      const primary = sorted.find(s => (s.kind ?? 'skill') === (r.mode ?? 'skill')) ?? sorted[0] ?? null
      view = { kind: 'skill', recording: r, skill: primary, allSkills: sorted }
      render()
    }
    container.appendChild(card)
  }
}

// ---- Settings tab ----

function settingsTab() {
  const d = document.createElement('div')
  d.style.cssText = 'padding:20px;display:flex;flex-direction:column;gap:12px;'

  const initials   = (currentUser?.email || 'OA').slice(0, 2).toUpperCase()
  const shortcutHtml = ['Alt','+','Shift','+','R'].map((k,i) => i%2===0
    ? `<span style="background:rgba(182,128,57,0.15);border:1px solid rgba(182,128,57,0.28);border-radius:4px;padding:2px 7px;font-family:'JetBrains Mono',monospace;font-size:11px;color:#E4AF7A;">${k}</span>`
    : `<span style="color:rgba(255,232,199,0.35);font-size:10px;">${k}</span>`).join('')

  d.innerHTML = `
    <div class="glass" style="padding:16px;">
      <div style="display:flex;align-items:center;gap:12px;margin-bottom:16px;">
        <div style="width:40px;height:40px;border-radius:50%;background:linear-gradient(135deg,#C68A41,#7A4F1E);display:flex;align-items:center;justify-content:center;flex-shrink:0;font-family:'Bebas Neue',sans-serif;font-size:16px;color:#1a0a00;letter-spacing:0.08em;">${initials}</div>
        <div style="flex:1;min-width:0;">
          <div class="label" style="font-size:9px;margin-bottom:2px;">Signed in as</div>
          <div style="font-size:13px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:#FFE8C7;">${escapeHtml(currentUser?.email || '')}</div>
        </div>
      </div>
      <button id="signout-btn" class="btn" style="width:100%;">Sign out</button>
    </div>

    <div class="glass" style="padding:16px;">
      <div class="label" style="font-size:9px;margin-bottom:12px;">Export</div>
      <button id="export-btn" class="btn" style="width:100%;font-size:12px;margin-bottom:8px;">Download all skills (.zip)</button>
      <p style="font-size:11px;line-height:1.6;color:rgba(255,232,199,0.38);">All your SKILL.md files in one zip — drop into <code style="font-family:monospace;font-size:10px;background:rgba(182,128,57,0.12);padding:1px 4px;border-radius:3px;color:#E4AF7A;">~/.claude/skills/</code>.</p>
    </div>

    <div class="glass" style="padding:16px;">
      <div class="label" style="font-size:9px;margin-bottom:12px;">Global keyboard shortcut</div>
      <div style="display:flex;align-items:center;justify-content:space-between;">
        <span style="font-size:12px;color:rgba(255,232,199,0.65);">Toggle recording</span>
        <div style="display:flex;gap:4px;align-items:center;">${shortcutHtml}</div>
      </div>
      <p style="font-size:10px;margin-top:8px;line-height:1.6;color:rgba(255,232,199,0.30);">Works anywhere on your desktop — even when Scout is in the background.</p>
    </div>

    <div class="glass" style="padding:16px;">
      <div class="label" style="font-size:9px;margin-bottom:8px;">MCP SERVERS</div>
      <div id="mcp-status-list"></div>
      <p style="font-size:10px;margin-top:8px;line-height:1.5;color:rgba(255,232,199,0.30);">Add servers to <code style="font-family:monospace;font-size:10px;background:rgba(182,128,57,0.10);padding:1px 4px;border-radius:3px;color:#E4AF7A;">~/.claude.json</code> under <code style="font-family:monospace;font-size:10px;background:rgba(182,128,57,0.10);padding:1px 4px;border-radius:3px;color:#E4AF7A;">mcpServers</code> — Scout loads them automatically on startup.</p>
    </div>

    <div class="glass" style="padding:16px;">
      <div class="label" style="font-size:9px;margin-bottom:4px;">Version</div>
      <div style="font-size:12px;color:rgba(255,232,199,0.45);">Scout v2.4.1 · Orage AI Agency · Desktop</div>
    </div>
  `

  d.querySelector('#signout-btn').onclick = doSignOut
  d.querySelector('#export-btn').onclick  = exportAllSkills

  const mcpListEl = d.querySelector('#mcp-status-list')
  renderMCPStatus(mcpListEl)
  return d
}

function renderMCPStatus(el) {
  if (!el) return
  const entries = Object.entries(mcpStatus)
  if (!entries.length) {
    el.innerHTML = `<div style="font-size:11px;color:rgba(255,232,199,0.30);">No MCP servers connected.</div>`
    return
  }
  el.innerHTML = entries.map(([name, info]) => `
    <div style="display:flex;align-items:center;justify-content:space-between;padding:6px 0;border-bottom:1px solid rgba(182,128,57,0.08);">
      <div style="display:flex;align-items:center;gap:7px;">
        <div style="width:6px;height:6px;border-radius:50%;background:#4ADE80;flex-shrink:0;"></div>
        <span style="font-size:12px;color:#FFE8C7;">${escapeHtml(name)}</span>
      </div>
      <span style="font-size:10px;color:rgba(255,232,199,0.35);">${info.tools.length} tool${info.tools.length !== 1 ? 's' : ''}</span>
    </div>
  `).join('')
}

// ---- Skill view ----

function skillView(rec, skill, allSkills) {
  const d = document.createElement('div')
  d.style.cssText = 'padding:16px 20px;'

  const topRow = document.createElement('div')
  topRow.style.cssText = 'display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:12px;'
  topRow.innerHTML = `
    <button id="back" class="btn btn-ghost" style="padding:5px 8px;font-size:11px;">← Library</button>
    <span class="${statusColor(rec.status)}" style="font-family:'Bebas Neue',sans-serif;font-size:9px;letter-spacing:0.18em;text-transform:uppercase;">${rec.status}</span>`
  topRow.querySelector('#back').onclick = () => { view = { kind: 'idle', tab: 'library' }; render() }
  d.appendChild(topRow)

  const wordCount = skill ? skill.body_md.replace(/^---[\s\S]*?---\n?/m,'').replace(/[#*`[\]()]/g,'').split(/\s+/).filter(Boolean).length : 0
  const readMins  = wordCount > 0 ? Math.ceil(wordCount / 200) : 0
  const qScore    = skill ? skillQualityScore(rec, skill) : null

  const meta = document.createElement('div')
  meta.className = 'glass'
  meta.style.cssText = 'padding:16px;margin-bottom:12px;'
  meta.innerHTML = `
    <div class="display" style="font-size:17px;color:#E4AF7A;margin-bottom:4px;">${escapeHtml(rec.title || 'Untitled')}</div>
    <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap;margin-bottom:4px;">
      <span style="font-size:11px;color:rgba(255,232,199,0.40);">${new Date(rec.started_at).toLocaleString(undefined,{month:'short',day:'numeric',hour:'numeric',minute:'2-digit'})} · ${rec.duration_ms ? Math.round(rec.duration_ms/1000)+'s' : '—'}</span>
      ${qScore ? `<span style="font-family:'Bebas Neue',sans-serif;font-size:9px;letter-spacing:0.18em;text-transform:uppercase;color:${qScore.color};background:rgba(0,0,0,0.28);border:1px solid currentColor;border-radius:3px;padding:1px 5px;">${qScore.label}</span>` : ''}
    </div>
    ${wordCount > 0 ? `<div style="font-size:10px;color:rgba(255,232,199,0.28);">${wordCount} words · ${readMins} min read · v${skill?.version ?? 1}</div>` : ''}`
  d.appendChild(meta)

  if (!skill) {
    const gen = document.createElement('div'); gen.className = 'glass'; gen.style.cssText = 'padding:16px;'
    gen.innerHTML = `<div style="font-size:13px;margin-bottom:12px;color:#FFE8C7;">No skill generated yet.</div>`
    d.appendChild(gen); return d
  }

  const isImprovement = skill.kind === 'improvement' || rec.mode === 'improvement'
  const actions = document.createElement('div')
  actions.style.cssText = 'display:flex;flex-direction:column;gap:8px;margin-bottom:12px;'

  if (isImprovement) {
    actions.innerHTML = `
      <button id="cc-copy" class="btn btn-primary" style="width:100%;">Copy for Claude Code</button>
      <div style="display:grid;grid-template-columns:1fr 1fr;gap:8px;">
        <button id="cp" class="btn" style="font-size:11px;">Copy raw</button>
        <button id="dl" class="btn" style="font-size:11px;">Save .md</button>
      </div>`
  } else {
    actions.innerHTML = `
      <button id="run-skill" class="btn btn-primary" style="width:100%;font-size:14px;padding:12px 16px;">✦ Run automatically</button>
      <div style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:8px;">
        <button id="cc-copy" class="btn" style="font-size:11px;">Copy for AI</button>
        <button id="cp" class="btn" style="font-size:11px;">Copy raw</button>
        <button id="dl" class="btn" style="font-size:11px;">Save .md</button>
      </div>`
  }

  // ✦ Run automatically — hand the skill to the background agent
  actions.querySelector('#run-skill')?.addEventListener('click', async () => {
    const btn = actions.querySelector('#run-skill')
    btn.disabled = true; btn.textContent = 'Starting agent…'
    const task = `You are replaying a workflow the user already performed. Your job is to REPLICATE their actions exactly, in the BACKGROUND, with ZERO user interaction.

Hard rules:
1. If the workflow is to SEND AN EMAIL via Gmail, you MUST use the gmail_send tool. Do NOT use browser_open + browser_action to click through Gmail's compose UI — that is slow, fragile, and burns tokens. gmail_send does the whole compose+send in one call. Pass the exact to/subject/body from the skill (empty strings are fine).
2. Treat the skill body as ground truth. Every URL, recipient, subject, body text, and file path mentioned in the skill is what the user actually used. Pass those exact strings to your tools. Do NOT paraphrase, "improve", or substitute placeholder values like "test", "example.com", "user@example.com".
3. If a required value is genuinely missing from the skill, STOP. Emit a single message starting with "NEEDS:" listing the missing fields and end the run. Do NOT improvise.
4. The browser runs HIDDEN. Drive everything via tools. Never ask the user to click anything. The only exception is if gmail_send returns { needsSignin: true } — that means the user needs to sign in to Gmail once. Surface the error message verbatim and end the run.
5. When done in one shot, just call the right tool and stop. Don't take screenshots "to verify" — if the tool returns success, it succeeded.
6. Final summary: 1-2 lines. Exact values used (recipient, subject, etc.) so the user can verify.

--- SKILL ---

${skill.body_md.trim()}

--- END SKILL ---`
    try {
      const { error } = await window.electronAPI.startAgentBg({ task, token: SUPABASE_ANON_KEY })
      if (error) { alert('Agent failed to start: ' + error); btn.disabled = false; btn.textContent = '✦ Run automatically'; return }
      bgAgentSteps = []; bgAgentTask = (skill.title || 'Run skill') + ' — auto-execution'; bgAgentRunning = true
      view = { kind: 'agent-bg-running' }
      render()
    } catch (e) {
      alert('Could not start agent: ' + (e.message || e))
      btn.disabled = false; btn.textContent = '✦ Run automatically'
    }
  })

  actions.querySelector('#cc-copy').onclick = async () => {
    const btn  = actions.querySelector('#cc-copy')
    const desc = (skill.body_md.match(/^description:\s*(.+)$/m)?.[1] ?? 'this workflow').trim()
    const text = isImprovement
      ? `You are about to make a change based on a Scout recording. Read the brief, ask if anything is unclear, then make the change.\n\n---\n\n${skill.body_md.trim()}\n\n---\n\nSummarise the files you changed and any decisions you made.`
      : `I'm sharing a skill with you so you can use it in this session. Learn it and confirm you understand it.\n\n---\n\n${skill.body_md.trim()}\n\n---\n\nWhen I ask you to perform tasks matching this skill's description ("${desc}"), follow the steps above.`
    await navigator.clipboard.writeText(text)
    btn.textContent = 'Copied — paste into Claude Code'
    setTimeout(() => { btn.textContent = isImprovement ? 'Copy for Claude Code' : 'Copy for Claude Code — use right now' }, 2500)
  }

  actions.querySelector('#cp').onclick = async () => {
    const btn = actions.querySelector('#cp')
    await navigator.clipboard.writeText(skill.body_md)
    btn.textContent = 'Copied ✓'; setTimeout(() => { btn.textContent = 'Copy raw' }, 1500)
  }

  actions.querySelector('#dl').onclick = async () => {
    const filename = `${(skill.title || 'skill').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')}.md`
    await window.electronAPI.saveFile({
      defaultName: filename,
      buffer:      Array.from(new TextEncoder().encode(skill.body_md)),
      mimeType:    'Markdown',
      extensions:  ['md'],
    })
  }

  d.appendChild(actions)

  const slug = (skill.body_md.match(/^name:\s*(.+)$/m)?.[1] ?? 'skill').trim()
  const hint = document.createElement('div')
  hint.className = 'glass'; hint.style.cssText = 'padding:12px;margin-bottom:12px;'
  hint.innerHTML = `
    <div class="label" style="font-size:8px;margin-bottom:4px;">Install</div>
    <div style="font-size:11px;line-height:1.6;color:rgba(255,232,199,0.55);">
      Save .md and move to <code style="font-family:monospace;font-size:10px;background:rgba(182,128,57,0.13);padding:1px 5px;border-radius:3px;color:#E4AF7A;">~/.claude/skills/</code>
      — Claude Code picks up <span style="color:#E4AF7A;font-weight:600;">${escapeHtml(slug)}</span> on next session.
    </div>`
  d.appendChild(hint)

  const { frontmatter, body } = splitFrontmatter(stripImageRefs(skill.body_md))
  if (frontmatter) {
    const fm = document.createElement('div')
    fm.className = 'glass'; fm.style.cssText = "padding:12px;margin-bottom:12px;font-family:'JetBrains Mono',monospace;font-size:11px;line-height:1.6;color:rgba(255,232,199,0.48);white-space:pre-wrap;word-break:break-word;"
    fm.textContent = frontmatter; d.appendChild(fm)
  }

  const mdWrap = document.createElement('div'); mdWrap.style.position = 'relative'
  const md = document.createElement('article'); md.className = 'skill-md text-primary'
  md.innerHTML = renderSkillMd(body)
  const fade = document.createElement('div'); fade.className = 'skill-body-fade'
  mdWrap.appendChild(md); mdWrap.appendChild(fade); d.appendChild(mdWrap)

  const cta = document.createElement('div')
  cta.className = 'glass'; cta.style.cssText = 'padding:16px;margin-top:12px;margin-bottom:8px;display:flex;align-items:center;justify-content:space-between;'
  cta.innerHTML = `
    <div>
      <div style="font-size:12px;font-weight:600;color:#FFE8C7;">Capture another workflow?</div>
      <div style="font-size:10px;margin-top:2px;color:rgba(255,232,199,0.40);">Each recording sharpens your AI agent.</div>
    </div>
    <button id="cta-rec" class="btn btn-primary" style="font-size:11px;padding:6px 12px;white-space:nowrap;">Record →</button>`
  cta.querySelector('#cta-rec').onclick = () => { view = { kind: 'idle', tab: 'record' }; render() }
  d.appendChild(cta)
  return d
}

// ---- Utilities ----

function escapeHtml(s) {
  if (!s) return ''
  return String(s).replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]))
}
function statusColor(s) {
  if (s === 'ready')                               return 'status-ready'
  if (s === 'failed')                              return 'status-failed'
  if (s === 'transcribing' || s === 'uploading')   return 'status-progress'
  return 'status-idle'
}
function splitFrontmatter(md) {
  const m = md?.match(/^---\n([\s\S]*?)\n---\n?/)
  if (!m) return { frontmatter: '', body: md || '' }
  return { frontmatter: m[1].trim(), body: md.slice(m[0].length) }
}
function stripImageRefs(md) {
  return (md || '').replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/[ \t]+\n/g, '\n')
}
function highlightVariables(html) {
  return html.replace(/(?<![="a-zA-Z0-9])\{([a-z_][a-z0-9_]*)\}/g, (_, n) => `<span class="skill-var">{${n}}</span>`)
}
function renderSkillMd(bodyMd) {
  if (window.marked) return highlightVariables(window.marked.parse(bodyMd))
  return escapeHtml(bodyMd).replace(/\n/g, '<br>')
}
function skillQualityScore(rec, skill) {
  let pts = 0
  const dur = rec.duration_ms ?? 0
  if (dur >= 120000) pts += 30; else if (dur >= 30000) pts += 20; else if (dur >= 5000) pts += 10
  const words = (rec.transcript?.segments ?? []).reduce((n, s) => n + (s.text?.split(/\s+/).filter(Boolean).length ?? 0), 0)
  if (words >= 100) pts += 30; else if (words >= 20) pts += 20; else if (words > 0) pts += 10
  const bodyLen = skill.body_md?.length ?? 0
  if (bodyLen >= 2000) pts += 40; else if (bodyLen >= 800) pts += 25; else if (bodyLen >= 200) pts += 15
  const score = Math.min(100, pts)
  if (score >= 85) return { score, label: 'Excellent', color: '#4ADE80' }
  if (score >= 65) return { score, label: 'Strong',    color: '#E4AF7A' }
  if (score >= 40) return { score, label: 'Good',      color: 'rgba(255,232,199,0.65)' }
  return              { score, label: 'Minimal',        color: 'rgba(255,232,199,0.35)' }
}

// ---- Agent ----

const AGENT_TOOLS = [
  {
    name: 'bash',
    description: `Run a shell command on the user's ${PLATFORM.label} computer using ${PLATFORM.shellLabel}. Use for file ops, running scripts, git, npm, Python, etc. Stdout and stderr are returned. Timeout 5 min.`,
    input_schema: {
      type: 'object',
      properties: {
        command: { type: 'string', description: `${PLATFORM.shellLabel} command to execute` },
        cwd:     { type: 'string', description: 'Working directory (optional, defaults to home)' },
      },
      required: ['command'],
    },
  },
  {
    name: 'read_file',
    description: 'Read the full text contents of a file on the user\'s computer.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Absolute file path' } },
      required: ['path'],
    },
  },
  {
    name: 'write_file',
    description: 'Write or overwrite a file on the user\'s computer with the given content. Creates parent directories if needed.',
    input_schema: {
      type: 'object',
      properties: {
        path:    { type: 'string', description: 'Absolute file path' },
        content: { type: 'string', description: 'Text content to write' },
      },
      required: ['path', 'content'],
    },
  },
  {
    name: 'list_dir',
    description: 'List files and folders inside a directory.',
    input_schema: {
      type: 'object',
      properties: { path: { type: 'string', description: 'Absolute directory path' } },
      required: ['path'],
    },
  },
  {
    name: 'browser_open',
    description: 'Open a URL in a controlled browser window. You can then use browser_action to interact with it.',
    input_schema: {
      type: 'object',
      properties: { url: { type: 'string', description: 'Full URL to open (include https://)' } },
      required: ['url'],
    },
  },
  {
    name: 'browser_action',
    description: 'Interact with the currently open browser window. Always start with a screenshot to see the current state.',
    input_schema: {
      type: 'object',
      properties: {
        action: {
          type: 'string',
          enum: ['screenshot', 'get_text', 'get_url', 'navigate', 'click', 'type', 'wait', 'eval'],
          description: 'screenshot=capture page image, get_text=page text, navigate=go to URL, click=click element, type=fill input, wait=pause ms, eval=run JS',
        },
        selector: { type: 'string', description: 'CSS selector for click/type' },
        text:     { type: 'string', description: 'URL for navigate, text to type, or ms to wait' },
        script:   { type: 'string', description: 'JavaScript code for eval action' },
      },
      required: ['action'],
    },
  },
]

const AGENT_SYSTEM = `You are an AI agent embedded in Scout Desktop, running on a ${PLATFORM.label} computer (home: ${PLATFORM.homeHint}). You help users automate tasks by executing commands, reading/writing files, and controlling a browser.

Guidelines:
- Be precise and efficient. Plan your approach, then execute.
- After browser_open, always take a screenshot first to understand the page state.
- Use ${PLATFORM.shellSyntax} in bash commands.
- When you write files, confirm the path and content before writing.
- If you encounter an error, explain it clearly and try an alternative approach.
- When the task is complete, summarize what you did concisely.`

let agentSession = null

async function runAgent(task) {
  if (!supabase || !currentUser) return
  const { data: sessionData } = await supabase.auth.getSession()
  const token = SUPABASE_ANON_KEY
  if (!token) return

  agentSession = {
    task,
    messages: [{ role: 'user', content: task }],
    steps: [],
    stopped: false,
    startedAt: Date.now(),
  }

  view = { kind: 'agent-running', session: agentSession }
  render()

  const MAX_ITERATIONS = 30
  let iteration = 0

  while (iteration < MAX_ITERATIONS && !agentSession.stopped) {
    iteration++

    let assistantContent = []
    let currentToolUse = null
    let currentText = ''
    let buffer = ''

    try {
      const res = await fetch(`${SUPABASE_URL}/functions/v1/agent-run`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
        body: JSON.stringify({
          messages: agentSession.messages,
          tools: AGENT_TOOLS,
          system: AGENT_SYSTEM,
        }),
      })

      if (!res.ok) {
        const errText = await res.text().catch(() => res.status)
        agentSession.steps.push({ type: 'error', text: `Agent error (${res.status}): ${errText}` })
        updateAgentView()
        break
      }

      const reader = res.body.getReader()
      const decoder = new TextDecoder()

      while (!agentSession.stopped) {
        const { done, value } = await reader.read()
        if (done) break

        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop()

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue
          const raw = line.slice(6).trim()
          if (raw === '[DONE]') break
          let event
          try { event = JSON.parse(raw) } catch { continue }

          if (event.type === 'content_block_start') {
            if (event.content_block?.type === 'tool_use') {
              currentToolUse = { id: event.content_block.id, name: event.content_block.name, inputRaw: '' }
            }
          } else if (event.type === 'content_block_delta') {
            if (event.delta?.type === 'text_delta') {
              currentText += event.delta.text
              updateAgentStreamText(currentText)
            } else if (event.delta?.type === 'input_json_delta' && currentToolUse) {
              currentToolUse.inputRaw += event.delta.partial_json
            }
          } else if (event.type === 'content_block_stop') {
            if (currentToolUse) {
              try { currentToolUse.input = JSON.parse(currentToolUse.inputRaw || '{}') } catch { currentToolUse.input = {} }
              assistantContent.push({ type: 'tool_use', id: currentToolUse.id, name: currentToolUse.name, input: currentToolUse.input })
              currentToolUse = null
            } else if (currentText) {
              assistantContent.push({ type: 'text', text: currentText })
              agentSession.steps.push({ type: 'text', text: currentText })
              updateAgentView()
              currentText = ''
            }
          } else if (event.type === 'message_stop') {
            break
          }
        }
      }
    } catch (e) {
      agentSession.steps.push({ type: 'error', text: 'Network error: ' + e.message })
      updateAgentView()
      break
    }

    if (!assistantContent.length) break
    agentSession.messages.push({ role: 'assistant', content: assistantContent })

    const toolCalls = assistantContent.filter(b => b.type === 'tool_use')
    if (!toolCalls.length) break

    const toolResults = []
    for (const tc of toolCalls) {
      if (agentSession.stopped) break
      agentSession.steps.push({ type: 'tool-call', tool: tc.name, input: tc.input, id: tc.id })
      updateAgentView()

      const result = await executeAgentTool(tc.name, tc.input)

      agentSession.steps.push({ type: 'tool-result', tool: tc.name, result, id: tc.id })
      updateAgentView()

      const resultText = typeof result === 'object'
        ? (result.error ? `Error: ${result.error}` : JSON.stringify(result, null, 2))
        : String(result)

      toolResults.push({ type: 'tool_result', tool_use_id: tc.id, content: resultText.slice(0, 20000) })
    }

    if (toolResults.length) {
      agentSession.messages.push({ role: 'user', content: toolResults })
    }
  }

  if (!agentSession.stopped) {
    agentSession.stopped = true
    agentSession.done = true
    agentSession.elapsed = Date.now() - agentSession.startedAt
    updateAgentView()
    void detectAndOfferCredentials()
    void generateSkillFromAgentSession()
  }
}

async function executeAgentTool(name, input) {
  switch (name) {
    case 'bash':          return window.electronAPI.agentBash(input)
    case 'read_file':     return window.electronAPI.agentReadFile(input)
    case 'write_file':    return window.electronAPI.agentWriteFile(input)
    case 'list_dir':      return window.electronAPI.agentListDir(input)
    case 'browser_open':  return window.electronAPI.agentBrowserOpen(input)
    case 'browser_action': return window.electronAPI.agentBrowserAction(input)
    default: return { error: `Unknown tool: ${name}` }
  }
}

function updateAgentStreamText(text) {
  const el = document.getElementById('agent-stream-text')
  if (el) el.textContent = text
}

function updateAgentView() {
  const feed = document.getElementById('agent-feed')
  if (!feed || !agentSession) return

  feed.innerHTML = ''
  for (const step of agentSession.steps) {
    const el = document.createElement('div')
    if (step.type === 'text') {
      el.style.cssText = 'font-size:12px;line-height:1.65;color:rgba(255,232,199,0.75);padding:8px 0;white-space:pre-wrap;'
      el.textContent = step.text
    } else if (step.type === 'tool-call') {
      el.className = 'glass'
      el.style.cssText = 'padding:10px 12px;border-left:2px solid rgba(182,128,57,0.55);'
      const inputSummary = summarizeToolInput(step.tool, step.input)
      el.innerHTML = `
        <div style="display:flex;align-items:center;gap:6px;margin-bottom:4px;">
          <span style="font-size:10px;font-family:'Bebas Neue',sans-serif;letter-spacing:0.12em;color:#E4AF7A;">${toolIcon(step.tool)} ${step.tool}</span>
        </div>
        <div style="font-size:10px;font-family:'JetBrains Mono',monospace;color:rgba(255,232,199,0.50);white-space:pre-wrap;word-break:break-all;">${escapeHtml(inputSummary)}</div>
      `
    } else if (step.type === 'tool-result') {
      const res = step.result
      const ok = !res?.error
      el.style.cssText = `font-size:10px;font-family:'JetBrains Mono',monospace;color:${ok ? 'rgba(74,222,128,0.65)' : '#F87171'};padding:4px 0 8px;white-space:pre-wrap;word-break:break-all;max-height:80px;overflow:hidden;`
      const text = res?.error ? `✗ ${res.error}` : formatToolResult(step.tool, res)
      el.textContent = text
    } else if (step.type === 'error') {
      el.style.cssText = 'font-size:11px;color:#F87171;padding:8px 0;'
      el.textContent = step.text
    } else if (step.type === 'status') {
      el.style.cssText = 'font-size:10px;color:rgba(228,175,122,0.65);padding:4px 0;font-style:italic;'
      el.textContent = `· ${step.text}`
    }
    feed.appendChild(el)
  }

  feed.scrollTop = feed.scrollHeight
  const doneBar = document.getElementById('agent-done-bar')
  if (doneBar && agentSession.done) doneBar.style.display = 'flex'
}

function summarizeToolInput(tool, input) {
  if (tool === 'bash') return input.command || ''
  if (tool === 'read_file') return input.path || ''
  if (tool === 'write_file') return `${input.path}\n${(input.content || '').slice(0, 120)}${input.content?.length > 120 ? '…' : ''}`
  if (tool === 'list_dir') return input.path || ''
  if (tool === 'browser_open') return input.url || ''
  if (tool === 'browser_action') return `${input.action}${input.selector ? ' ' + input.selector : ''}${input.text ? ' → ' + input.text : ''}`
  return JSON.stringify(input)
}

function formatToolResult(tool, res) {
  if (!res) return ''
  if (tool === 'bash') {
    const out = [res.stdout, res.stderr].filter(Boolean).join('\n').trim()
    return (out || '(no output)').slice(0, 200)
  }
  if (tool === 'read_file') return `✓ ${res.content?.length ?? 0} chars`
  if (tool === 'write_file') return res.success ? '✓ written' : `✗ ${res.error}`
  if (tool === 'list_dir') return res.entries ? `✓ ${res.entries.length} items` : `✗ ${res.error}`
  if (tool === 'browser_open') return res.success ? `✓ ${res.url}` : `✗ ${res.error}`
  if (tool === 'browser_action') {
    if (res.dataUrl) return '✓ screenshot captured'
    if (res.url) return `✓ ${res.url}`
    if (res.text) return `✓ text: ${res.text.slice(0, 80)}`
    return res.success ? '✓' : `✗ ${res.error || ''}`
  }
  return '✓'
}

function toolIcon(tool) {
  return { bash: '>', read_file: 'R', write_file: 'W', list_dir: 'L', browser_open: 'B', browser_action: 'B' }[tool] || '·'
}

async function detectAndOfferCredentials() {
  if (!agentSession?.messages?.length) return
  const { data: sessionData } = await supabase.auth.getSession()
  const token = SUPABASE_ANON_KEY
  if (!token) return

  const transcript = agentSession.messages
    .filter(m => m.role === 'assistant')
    .flatMap(m => Array.isArray(m.content) ? m.content.filter(b => b.type === 'text').map(b => b.text) : [m.content])
    .join('\n')
    .slice(0, 8000)

  if (!transcript.trim()) return

  try {
    const res = await fetch(`${SUPABASE_URL}/functions/v1/agent-run`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({
        tools: [],
        system: 'You extract credentials from text. Return ONLY a JSON array like [{"key":"ENV_VAR_NAME","value":"the_value","description":"what it is"}]. Return [] if none found. No other text.',
        messages: [{ role: 'user', content: `Find any API keys, passwords, tokens, or secrets in this text. Use ALL_CAPS_ENV names:\n\n${transcript}` }],
      }),
    })

    let rawText = ''
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split('\n'); buf = lines.pop()
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const raw = line.slice(6).trim()
        if (raw === '[DONE]') break
        try {
          const ev = JSON.parse(raw)
          if (ev.delta?.type === 'text_delta') rawText += ev.delta.text
        } catch {}
      }
    }

    const match = rawText.match(/\[[\s\S]*\]/)
    if (!match) return
    const creds = JSON.parse(match[0])
    if (!Array.isArray(creds) || !creds.length) return

    view = { kind: 'agent-cred-review', session: agentSession, creds }
    render()
  } catch (e) {
    console.warn('Credential detection failed:', e)
    void generateSkillFromAgentSession()
  }
}

async function generateSkillFromAgentSession() {
  if (!agentSession || !supabase || !currentUser) return
  const { data: sessionData } = await supabase.auth.getSession()
  const token = SUPABASE_ANON_KEY
  if (!token) return

  const transcript = agentSession.messages.map(m => {
    if (m.role === 'user' && typeof m.content === 'string') return `User: ${m.content}`
    if (m.role === 'assistant') {
      const parts = Array.isArray(m.content) ? m.content : [m.content]
      return parts.map(b => b.type === 'text' ? `Assistant: ${b.text}` : `[Tool: ${b.name}(${JSON.stringify(b.input).slice(0,100)})]`).join('\n')
    }
    return ''
  }).filter(Boolean).join('\n\n').slice(0, 12000)

  const recId = crypto.randomUUID()
  const now   = new Date().toISOString()

  try {
    await supabase.from('recordings').insert({
      id: recId, user_id: currentUser.id,
      title: agentSession.task.slice(0, 120),
      status: 'drafting',
      started_at: new Date(agentSession.startedAt).toISOString(),
      ended_at: now,
      duration_ms: agentSession.elapsed || 0,
      mode: 'skill',
      transcript: { segments: [{ text: transcript }] },
      meta: { source: 'agent', platform: window.electronAPI.platform },
    })

    const fakeRec = { id: recId, title: agentSession.task.slice(0, 120), mode: 'skill', duration_ms: agentSession.elapsed || 0, _agentTranscript: transcript }
    view = { kind: 'processing', recording: fakeRec, stage: 'drafting', error: null }
    render()

    const skillRes = await fetch(`${SUPABASE_URL}/functions/v1/generate-skill`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ recording_id: recId, extra_context: 'This skill was generated from an AI agent execution session.' }),
    })

    if (!skillRes.ok) {
      view = { kind: 'idle', tab: 'library' }; render()
      return
    }

    let finalSkill = null
    const reader2 = skillRes.body.getReader()
    const dec2 = new TextDecoder()
    let buf2 = '', liveText = ''

    while (true) {
      const { done, value } = await reader2.read()
      if (done) break
      buf2 += dec2.decode(value, { stream: true })
      const lines = buf2.split('\n'); buf2 = lines.pop()
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const raw = line.slice(6).trim()
        if (raw === '[DONE]') break
        try {
          const ev = JSON.parse(raw)
          if (ev.type === 'chunk') { liveText += ev.text; const lv = document.getElementById('live-skill-text'); if (lv) lv.textContent = liveText }
          if (ev.type === 'done') finalSkill = ev.skill
        } catch {}
      }
    }

    if (!finalSkill) { view = { kind: 'idle', tab: 'library' }; render(); return }
    const { data: rData } = await supabase.from('recordings').select('*, skills(*)').eq('id', recId).single()
    const skillObj = rData?.skills?.[0] ?? finalSkill
    view = { kind: 'skill', recording: rData ?? fakeRec, skill: skillObj, allSkills: rData?.skills ?? [skillObj] }
    render()
  } catch (e) {
    console.error('Agent skill generation failed:', e)
    view = { kind: 'idle', tab: 'library' }
    render()
  }
}

// ---- Background agent state mirror (populated by main-process events) ----

let bgAgentSteps   = []
let bgAgentRunning = false
let bgAgentTask    = ''
let mcpStatus      = {}
let monitorActive  = false
let latestFrame    = null

function initMainProcessListeners() {
  window.electronAPI.onAgentUpdate(data => {
    if (data.type === 'start') {
      bgAgentRunning = true; bgAgentTask = data.task; bgAgentSteps = []
      if (view.kind === 'agent-bg-running') updateBgAgentView()
    } else if (data.type === 'text') {
      bgAgentSteps.push({ type: 'text', text: data.text })
      if (view.kind === 'agent-bg-running') updateBgAgentView()
    } else if (data.type === 'text-delta') {
      const el = document.getElementById('agent-stream-text')
      if (el) el.textContent = data.text
    } else if (data.type === 'tool-call') {
      bgAgentSteps.push({ type: 'tool-call', tool: data.tool, input: data.input, id: data.id })
      if (view.kind === 'agent-bg-running') updateBgAgentView()
    } else if (data.type === 'tool-result') {
      bgAgentSteps.push({ type: 'tool-result', tool: data.tool, result: data.result, id: data.id })
      if (view.kind === 'agent-bg-running') updateBgAgentView()
    } else if (data.type === 'error') {
      bgAgentSteps.push({ type: 'error', text: data.text })
      if (view.kind === 'agent-bg-running') updateBgAgentView()
    } else if (data.type === 'status') {
      bgAgentSteps.push({ type: 'status', text: data.text })
      if (view.kind === 'agent-bg-running') updateBgAgentView()
    } else if (data.type === 'done') {
      bgAgentRunning = false
      if (view.kind === 'agent-bg-running') {
        const doneBar = document.getElementById('agent-done-bar')
        if (doneBar) doneBar.style.display = 'flex'
        const statusEl = document.getElementById('agent-bg-status')
        if (statusEl) statusEl.innerHTML = `<div style="width:6px;height:6px;border-radius:50%;background:rgba(255,232,199,0.28);flex-shrink:0;"></div><span style="font-size:10px;color:rgba(255,232,199,0.45);">Completed in ${Math.round((data.elapsed||0)/1000)}s</span>`
      }
      void generateSkillFromBgSession()
    }
  })

  window.electronAPI.onMonitorFrame(data => {
    latestFrame = data
    const img = document.getElementById('monitor-live-img')
    if (img) { img.src = data.dataUrl; img.style.display = 'block' }
    const ct  = document.getElementById('monitor-frame-count')
    if (ct) ct.textContent = `${data.total} frame${data.total !== 1 ? 's' : ''} captured`
  })

  // Macro state — pushed from main when record/play starts or stops, OR when
  // a hotkey or tray click triggers a state change. Re-render the Macros tab
  // if it's the current view so the big record button + list stay in sync.
  window.electronAPI.onMacroState(data => {
    macroState = data
    if (view.kind === 'idle' && view.tab === 'macros') render()
  })

  window.electronAPI.onMonitorStatus(data => {
    monitorActive = data.active
    const btn = document.getElementById('monitor-toggle-btn')
    if (btn) { btn.textContent = monitorActive ? 'Stop Monitor' : 'Start Monitor'; btn.className = monitorActive ? 'btn' : 'btn btn-primary' }
    const dot = document.getElementById('monitor-status-dot')
    if (dot) dot.style.background = monitorActive ? '#4ADE80' : 'rgba(255,232,199,0.20)'
  })

  window.electronAPI.onMCPReady(data => {
    mcpStatus = data
    const el = document.getElementById('mcp-status-list')
    if (el) renderMCPStatus(el)
  })
}

async function generateSkillFromBgSession() {
  if (!bgAgentSteps.length || !supabase || !currentUser) return
  const transcript = bgAgentSteps
    .filter(s => s.type === 'text')
    .map(s => s.text)
    .join('\n\n')
    .slice(0, 12000)
  if (!transcript.trim()) return

  const { data: sessionData } = await supabase.auth.getSession()
  const token = SUPABASE_ANON_KEY
  if (!token) return

  const recId = crypto.randomUUID()
  try {
    await supabase.from('recordings').insert({
      id: recId, user_id: currentUser.id,
      title: bgAgentTask.slice(0, 120),
      status: 'drafting',
      started_at: new Date().toISOString(), ended_at: new Date().toISOString(),
      duration_ms: 0, mode: 'skill',
      transcript: { segments: [{ text: transcript }] },
      meta: { source: 'bg-agent', platform: window.electronAPI.platform },
    })
    view = { kind: 'processing', recording: { id: recId, title: bgAgentTask.slice(0, 120), mode: 'skill', duration_ms: 0 }, stage: 'drafting', error: null }
    render()

    const skillRes = await fetch(`${SUPABASE_URL}/functions/v1/generate-skill`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      body: JSON.stringify({ recording_id: recId, extra_context: 'Generated from background agent session.' }),
    })
    if (!skillRes.ok) { view = { kind: 'idle', tab: 'library' }; render(); return }

    let finalSkill = null
    const reader = skillRes.body.getReader(); const dec = new TextDecoder(); let buf = '', liveText = ''
    while (true) {
      const { done, value } = await reader.read(); if (done) break
      buf += dec.decode(value, { stream: true })
      const lines = buf.split('\n'); buf = lines.pop()
      for (const line of lines) {
        if (!line.startsWith('data: ')) continue
        const raw = line.slice(6).trim(); if (raw === '[DONE]') break
        try { const ev = JSON.parse(raw); if (ev.type === 'chunk') { liveText += ev.text; const lv = document.getElementById('live-skill-text'); if (lv) lv.textContent = liveText } if (ev.type === 'done') finalSkill = ev.skill } catch {}
      }
    }
    if (!finalSkill) { view = { kind: 'idle', tab: 'library' }; render(); return }
    const { data: rData } = await supabase.from('recordings').select('*, skills(*)').eq('id', recId).single()
    const skillObj = rData?.skills?.[0] ?? finalSkill
    view = { kind: 'skill', recording: rData ?? { id: recId, title: bgAgentTask, mode: 'skill' }, skill: skillObj, allSkills: rData?.skills ?? [skillObj] }
    render()
  } catch (e) { console.error('Bg agent skill gen failed:', e); view = { kind: 'idle', tab: 'library' }; render() }
}

// ---- Starter tasks ----
// Real work the agent can do today with no extra setup, tuned for service-business owners.

const AGENT_STARTERS = [
  {
    icon: '🗂️',
    title: 'Tidy Downloads',
    prompt: `Look at every file in my Downloads folder. Group them by type — PDFs, images, code, installers, documents, archives — and move each group into a matching subfolder inside Downloads. Skip files I've touched in the last 24 hours. When done, give me a short summary of what moved where.`,
  },
  {
    icon: '🏢',
    title: 'Set up a client project',
    prompt: `Create a new client project folder on my Desktop called "Client - [REPLACE WITH NAME]". Inside it, make subfolders: Contract, Deliverables, Notes, Invoices, Assets. Inside Notes, create a README.md with sections for Project Brief, Stakeholders, Timeline, Key Decisions. Open the folder when done.`,
  },
  {
    icon: '🔍',
    title: 'Audit my website',
    prompt: `Open my website [REPLACE WITH URL], take a desktop screenshot, then resize the browser to mobile (375px wide) and screenshot again. Look at both. Tell me three concrete things to improve — copy, layout, calls-to-action, anything that looks weak — and save the findings as a markdown report on my Desktop.`,
  },
  {
    icon: '📰',
    title: 'Research a prospect',
    prompt: `Research [REPLACE WITH COMPANY NAME] for me. Search the web and find: what they do, their main products or services, key people (founders, leadership), recent news in the last 90 days, and any signals about whether they'd be a good fit for our agency. Save it as a one-page markdown brief on my Desktop.`,
  },
  {
    icon: '📅',
    title: 'Weekly recap',
    prompt: `Write a recap of what I worked on this week. Check: git activity in ~/Desktop (or any project folders) from the last 7 days, any meeting notes or markdown files I modified, and screenshots in Downloads/Desktop from this week. Pull it into a "Week ending [today]" markdown summary saved to my Desktop.`,
  },
  {
    icon: '📚',
    title: 'Summarize my notes',
    prompt: `Read every .md and .txt file in ~/Desktop/notes (or wherever I keep notes — find it). Pull out the action items, open decisions, and key insights from the last 30 days. Save a single "Notes digest" markdown file on my Desktop, grouped by theme.`,
  },
]

// ---- Agent tab ----

function agentTab() {
  const d = document.createElement('div')
  d.style.cssText = 'padding:20px;display:flex;flex-direction:column;gap:16px;'

  // MCP pill row
  const mcpCount   = Object.keys(mcpStatus).length
  const mcpPill    = mcpCount
    ? `<span style="font-size:9px;background:rgba(74,222,128,0.12);color:#4ADE80;border:1px solid rgba(74,222,128,0.25);border-radius:4px;padding:2px 7px;font-family:'Bebas Neue',sans-serif;letter-spacing:0.1em;">${mcpCount} MCP</span>`
    : ''

  d.innerHTML = `
    <div class="glass" style="padding:20px;display:flex;flex-direction:column;gap:14px;">
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;">
        <div>
          <div class="display" style="font-size:18px;color:#E4AF7A;">Run Agent</div>
          <p style="font-size:11px;line-height:1.65;margin-top:5px;color:rgba(255,232,199,0.45);">Describe a task. Claude executes it in the background — you can keep using your computer while it runs.</p>
        </div>
        ${mcpPill}
      </div>
      <div>
        <div class="label" style="font-size:9px;margin-bottom:8px;letter-spacing:0.14em;">TRY ONE OF THESE</div>
        <div id="agent-starters" style="display:flex;flex-wrap:wrap;gap:6px;">
          ${AGENT_STARTERS.map((s, i) => `
            <button class="agent-starter" data-i="${i}"
              style="display:inline-flex;align-items:center;gap:6px;padding:7px 11px;font-size:11px;line-height:1;background:rgba(228,175,122,0.06);color:var(--ink,#FFE8C7);border:1px solid rgba(228,175,122,0.18);border-radius:999px;cursor:pointer;font-family:inherit;transition:all 0.12s ease;">
              <span style="font-size:13px;">${s.icon}</span><span>${escapeHtml(s.title)}</span>
            </button>
          `).join('')}
        </div>
      </div>
      <textarea id="agent-task" class="input" rows="5"
        placeholder="Describe what you want done in plain English. Pick a starter above for an example, then edit it for your situation."
        style="resize:vertical;min-height:100px;font-size:12px;line-height:1.65;"></textarea>
      <div style="display:flex;gap:8px;">
        <button id="agent-run-bg" class="btn btn-primary" style="flex:1;font-size:13px;padding:10px;">Run in Background →</button>
      </div>
    </div>

    <div class="glass" style="padding:16px;border-color:rgba(182,128,57,0.15);">
      <div class="label" style="font-size:9px;margin-bottom:10px;">WHAT THE AGENT CAN DO</div>
      <div style="display:flex;flex-direction:column;gap:8px;">
        <div style="display:flex;align-items:flex-start;gap:8px;"><span style="font-size:13px;">⌨</span><span style="font-size:11px;line-height:1.6;color:rgba(255,232,199,0.55);">Run any ${PLATFORM.shellLabel} command on your machine</span></div>
        <div style="display:flex;align-items:flex-start;gap:8px;"><span style="font-size:13px;">📂</span><span style="font-size:11px;line-height:1.6;color:rgba(255,232,199,0.55);">Read and write files anywhere on your computer</span></div>
        <div style="display:flex;align-items:flex-start;gap:8px;"><span style="font-size:13px;">🌐</span><span style="font-size:11px;line-height:1.6;color:rgba(255,232,199,0.55);">Open URLs, click, type, and scrape web pages</span></div>
        ${mcpCount ? `<div style="display:flex;align-items:flex-start;gap:8px;"><span style="font-size:13px;">🔌</span><span style="font-size:11px;line-height:1.6;color:rgba(255,232,199,0.55);">${mcpCount} MCP server${mcpCount !== 1 ? 's' : ''} connected (${Object.keys(mcpStatus).join(', ')})</span></div>` : ''}
        <div style="display:flex;align-items:flex-start;gap:8px;"><span style="font-size:13px;">📝</span><span style="font-size:11px;line-height:1.6;color:rgba(255,232,199,0.55);">Every completed task is saved as a reusable skill guide automatically</span></div>
      </div>
    </div>
  `

  const runBg = async () => {
    const task = d.querySelector('#agent-task').value.trim()
    if (!task) return
    if (!supabase || !currentUser) return
    const { data: sessionData } = await supabase.auth.getSession()
    const token = SUPABASE_ANON_KEY
    if (!token) return
    const { error } = await window.electronAPI.startAgentBg({ task, token })
    if (error) { alert(error); return }
    bgAgentSteps = []; bgAgentTask = task; bgAgentRunning = true
    view = { kind: 'agent-bg-running' }
    render()
  }

  d.querySelector('#agent-run-bg').onclick = runBg
  d.querySelector('#agent-task').addEventListener('keydown', e => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) void runBg() })

  for (const chip of d.querySelectorAll('.agent-starter')) {
    chip.addEventListener('mouseenter', () => {
      chip.style.background    = 'rgba(228,175,122,0.14)'
      chip.style.borderColor   = 'rgba(228,175,122,0.45)'
    })
    chip.addEventListener('mouseleave', () => {
      chip.style.background    = 'rgba(228,175,122,0.06)'
      chip.style.borderColor   = 'rgba(228,175,122,0.18)'
    })
    chip.onclick = () => {
      const idx = parseInt(chip.dataset.i, 10)
      const starter = AGENT_STARTERS[idx]
      if (!starter) return
      const ta = d.querySelector('#agent-task')
      ta.value = starter.prompt
      ta.focus()
      ta.scrollTop = 0
    }
  }
  return d
}

// ---- Background agent running view ----

function updateBgAgentView() {
  const feed = document.getElementById('agent-feed')
  if (!feed) return
  feed.innerHTML = ''
  for (const step of bgAgentSteps) {
    const el = document.createElement('div')
    if (step.type === 'text') {
      el.style.cssText = 'font-size:12px;line-height:1.65;color:rgba(255,232,199,0.75);padding:8px 0;white-space:pre-wrap;'
      el.textContent = step.text
    } else if (step.type === 'tool-call') {
      el.className = 'glass'
      el.style.cssText = 'padding:10px 12px;border-left:2px solid rgba(182,128,57,0.55);'
      el.innerHTML = `<div style="font-size:10px;font-family:'Bebas Neue',sans-serif;letter-spacing:0.12em;color:#E4AF7A;margin-bottom:4px;">${toolIcon(step.tool)} ${step.tool}</div><div style="font-size:10px;font-family:'JetBrains Mono',monospace;color:rgba(255,232,199,0.50);white-space:pre-wrap;word-break:break-all;">${escapeHtml(summarizeToolInput(step.tool, step.input))}</div>`
    } else if (step.type === 'tool-result') {
      const ok = !step.result?.error
      el.style.cssText = `font-size:10px;font-family:'JetBrains Mono',monospace;color:${ok ? 'rgba(74,222,128,0.65)' : '#F87171'};padding:4px 0 8px;white-space:pre-wrap;word-break:break-all;max-height:80px;overflow:hidden;`
      el.textContent = step.result?.error ? `✗ ${step.result.error}` : formatToolResult(step.tool, step.result)
    } else if (step.type === 'error') {
      el.style.cssText = 'font-size:11px;color:#F87171;padding:8px 0;'
      el.textContent = step.text
    } else if (step.type === 'status') {
      el.style.cssText = 'font-size:10px;color:rgba(228,175,122,0.65);padding:4px 0;font-style:italic;'
      el.textContent = `· ${step.text}`
    }
    feed.appendChild(el)
  }
  feed.scrollTop = feed.scrollHeight
}

function bgAgentRunningView() {
  const d = document.createElement('div')
  d.style.cssText = 'padding:16px 20px;display:flex;flex-direction:column;gap:12px;'

  const header = document.createElement('div')
  header.className = 'glass'
  header.style.cssText = 'padding:16px;'
  header.innerHTML = `
    <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:8px;">
      <div class="display" style="font-size:16px;color:#E4AF7A;line-height:1.3;flex:1;">${escapeHtml((bgAgentTask || '').slice(0, 80))}${bgAgentTask.length > 80 ? '…' : ''}</div>
      <button id="agent-stop-btn" class="btn" style="font-size:11px;padding:5px 10px;flex-shrink:0;color:#F87171;border-color:rgba(248,113,113,0.3);">Stop</button>
    </div>
    <div id="agent-bg-status" style="display:flex;align-items:center;gap:6px;">
      <div style="width:6px;height:6px;border-radius:50%;background:#4ADE80;animation:pulse-dot-green 1.2s ease infinite;flex-shrink:0;"></div>
      <span style="font-size:10px;color:rgba(255,232,199,0.45);">Running in background — you can keep using your computer</span>
    </div>
  `
  header.querySelector('#agent-stop-btn').onclick = async () => {
    await window.electronAPI.stopAgentBg()
    bgAgentRunning = false
    view = { kind: 'idle', tab: 'agent' }; render()
  }
  d.appendChild(header)

  const feedWrap = document.createElement('div')
  feedWrap.className = 'glass'
  feedWrap.style.cssText = 'padding:14px 16px;min-height:280px;max-height:440px;overflow-y:auto;display:flex;flex-direction:column;gap:8px;'
  const streamText = document.createElement('div')
  streamText.id = 'agent-stream-text'
  streamText.style.cssText = 'font-size:12px;line-height:1.65;color:rgba(255,232,199,0.55);white-space:pre-wrap;font-style:italic;'
  const feed = document.createElement('div')
  feed.id = 'agent-feed'
  feed.style.cssText = 'display:flex;flex-direction:column;gap:8px;'
  feedWrap.appendChild(streamText); feedWrap.appendChild(feed)
  d.appendChild(feedWrap)

  const doneBar = document.createElement('div')
  doneBar.id = 'agent-done-bar'
  doneBar.style.cssText = 'display:none;gap:8px;'
  doneBar.innerHTML = `
    <button id="agent-view-skill" class="btn btn-primary" style="flex:1;font-size:12px;">View Skill →</button>
    <button id="agent-new-task"   class="btn"             style="flex:1;font-size:12px;">New Task</button>
  `
  doneBar.querySelector('#agent-view-skill').onclick = () => { view = { kind: 'idle', tab: 'library' }; render() }
  doneBar.querySelector('#agent-new-task').onclick   = () => { view = { kind: 'idle', tab: 'agent' };   render() }
  d.appendChild(doneBar)

  setTimeout(() => updateBgAgentView(), 0)
  return d
}

// ---- Macros tab (local-only record/replay; no sign-in) ----

// Mirrors the macro state from the main process. Updated by `onMacroState`
// pushes from main.js so other tabs reflect current recording / playback.
let macroState = { available: true, loadError: null, recorder: { recording: false }, player: { playing: false } }

function fmtDuration(ms) {
  if (!ms || ms < 1000) return `${ms || 0} ms`
  const s = Math.round(ms / 1000)
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60), r = s % 60
  return `${m}m ${r}s`
}
function fmtRelative(ts) {
  const dt = Date.now() - ts
  if (dt < 60_000)      return 'just now'
  if (dt < 3_600_000)   return `${Math.round(dt / 60_000)}m ago`
  if (dt < 86_400_000)  return `${Math.round(dt / 3_600_000)}h ago`
  return new Date(ts).toLocaleDateString()
}
// "in 12 minutes" / "in 2 hours" / "at 9:15 PM" — used by scheduled-runs UI.
function fmtUntil(ts) {
  const dt = ts - Date.now()
  if (dt < 0)            return 'overdue'
  if (dt < 60_000)       return 'in <1 min'
  if (dt < 3_600_000)    return `in ${Math.round(dt / 60_000)} min`
  if (dt < 24 * 3_600_000) {
    const t = new Date(ts).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
    return `at ${t}`
  }
  return new Date(ts).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
}
// HTML-datetime-local helper: takes a Date, returns "YYYY-MM-DDTHH:MM" in
// LOCAL time (NOT UTC) — what <input type="datetime-local"> expects.
function toLocalDatetimeInput(d) {
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function macrosTab() {
  const d = document.createElement('div')
  d.style.cssText = 'padding:20px;display:flex;flex-direction:column;gap:16px;'

  // Header card: big record button + live state
  const headerCard = document.createElement('div')
  headerCard.className = 'glass'
  headerCard.style.cssText = 'padding:18px;display:flex;flex-direction:column;gap:14px;align-items:center;'
  headerCard.innerHTML = `
    <div style="text-align:center;">
      <div class="display" style="font-size:18px;color:#E4AF7A;">Macro Mode</div>
      <p style="font-size:11px;line-height:1.6;margin-top:4px;color:rgba(255,232,199,0.50);max-width:280px;">
        Record your clicks and keystrokes, replay them exactly. No sign-in, runs in the background.
      </p>
    </div>
    <button id="macro-rec-btn" style="
      width:120px;height:120px;border-radius:50%;display:flex;align-items:center;justify-content:center;
      background:linear-gradient(160deg,#D4924A 0%,#9A6228 55%,#7A4A18 100%);
      border:1px solid rgba(228,175,122,0.65);
      box-shadow:0 1px 0 rgba(255,255,255,0.20) inset,0 -2px 0 rgba(0,0,0,0.32) inset,0 10px 40px rgba(182,128,57,0.44);
      cursor:pointer;transition:transform 0.15s;">
      <span id="macro-rec-icon" style="display:block;width:38px;height:38px;border-radius:50%;background:linear-gradient(180deg,#2a1506 0%,#1a0e02 100%);box-shadow:0 2px 8px rgba(0,0,0,0.60) inset;"></span>
    </button>
    <div id="macro-state-text" style="font-size:11px;color:rgba(255,232,199,0.55);text-align:center;min-height:14px;"></div>
    <div style="font-size:9px;color:rgba(255,232,199,0.32);letter-spacing:0.10em;text-transform:uppercase;text-align:center;">
      Hotkey · Alt + Shift + K
    </div>
  `
  d.appendChild(headerCard)

  // If native libs missing, show install hint and bail out (no list shown).
  if (macroState.available === false) {
    const warn = document.createElement('div')
    warn.className = 'glass'
    warn.style.cssText = 'padding:14px 16px;border-color:rgba(248,113,113,0.35);'
    warn.innerHTML = `
      <div class="label" style="font-size:9px;color:#F87171;margin-bottom:6px;">Macro engine missing</div>
      <div style="font-size:11px;line-height:1.6;color:rgba(255,232,199,0.65);margin-bottom:8px;">
        Scout needs two small native libraries to capture and replay input.
      </div>
      <div style="font-size:10px;font-family:'JetBrains Mono',ui-monospace,monospace;background:rgba(0,0,0,0.30);padding:8px 10px;border-radius:4px;color:#FFE8C7;line-height:1.5;">
        cd to the Scout folder<br/>
        npm install
      </div>
      <div style="font-size:10px;line-height:1.6;color:rgba(255,232,199,0.40);margin-top:8px;">
        ${escapeHtml(macroState.loadError || 'Native module not loaded.')}
      </div>
    `
    d.appendChild(warn)
    return d
  }

  // Scheduled runs — only visible when there's at least one pending.
  const schedWrap = document.createElement('div')
  schedWrap.style.cssText = 'display:none;flex-direction:column;gap:8px;'
  schedWrap.innerHTML = `
    <div style="display:flex;align-items:center;justify-content:space-between;padding:0 4px;">
      <span class="label" style="font-size:9px;color:#E4AF7A;">Scheduled runs</span>
      <span id="sched-count" class="label" style="font-size:9px;color:rgba(255,232,199,0.32);"></span>
    </div>
    <div id="sched-list" style="display:flex;flex-direction:column;gap:6px;"></div>
  `
  d.appendChild(schedWrap)

  // Saved macros list
  const listWrap = document.createElement('div')
  listWrap.style.cssText = 'display:flex;flex-direction:column;gap:10px;'
  const listHeader = document.createElement('div')
  listHeader.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:0 4px;'
  listHeader.innerHTML = `
    <span class="label" style="font-size:9px;">Saved macros</span>
    <span id="macro-count" class="label" style="font-size:9px;color:rgba(255,232,199,0.32);"></span>
  `
  listWrap.appendChild(listHeader)

  const listEl = document.createElement('div')
  listEl.id = 'macro-list'
  listEl.style.cssText = 'display:flex;flex-direction:column;gap:8px;'
  listWrap.appendChild(listEl)
  d.appendChild(listWrap)

  // ---- State render helpers ----

  const recBtn   = headerCard.querySelector('#macro-rec-btn')
  const recIcon  = headerCard.querySelector('#macro-rec-icon')
  const stateTxt = headerCard.querySelector('#macro-state-text')

  function paintHeader() {
    const rec = macroState.recorder?.recording
    const ply = macroState.player?.playing
    if (rec) {
      recBtn.style.background  = 'linear-gradient(160deg,#dc2626 0%,#991b1b 55%,#7f1d1d 100%)'
      recBtn.style.boxShadow   = '0 1px 0 rgba(255,255,255,0.20) inset,0 -2px 0 rgba(0,0,0,0.32) inset,0 10px 40px rgba(220,38,38,0.55)'
      recIcon.style.borderRadius = '6px'
      recIcon.style.width  = '32px'
      recIcon.style.height = '32px'
      const elapsed = Math.max(0, Date.now() - (macroState.recorder.started_at || Date.now()))
      stateTxt.textContent = `Recording · ${fmtDuration(elapsed)} · ${macroState.recorder.event_count || 0} events`
    } else if (ply) {
      recIcon.style.borderRadius = '50%'
      recIcon.style.width  = '38px'
      recIcon.style.height = '38px'
      stateTxt.textContent = `Replaying: ${macroState.player.name || 'macro'}`
    } else {
      recBtn.style.background  = 'linear-gradient(160deg,#D4924A 0%,#9A6228 55%,#7A4A18 100%)'
      recBtn.style.boxShadow   = '0 1px 0 rgba(255,255,255,0.20) inset,0 -2px 0 rgba(0,0,0,0.32) inset,0 10px 40px rgba(182,128,57,0.44)'
      recIcon.style.borderRadius = '50%'
      recIcon.style.width  = '38px'
      recIcon.style.height = '38px'
      stateTxt.textContent = 'Ready'
    }
  }

  async function reloadList() {
    const macros = await window.electronAPI.macroList()
    listEl.innerHTML = ''
    document.getElementById('macro-count').textContent =
      `${macros.length} macro${macros.length !== 1 ? 's' : ''}`
    if (!macros.length) {
      const empty = document.createElement('div')
      empty.style.cssText = 'padding:24px 16px;text-align:center;font-size:11px;color:rgba(255,232,199,0.36);line-height:1.7;'
      empty.innerHTML = `No macros yet.<br/>Hit the record button above to capture your first one.`
      listEl.appendChild(empty)
      return
    }
    for (const m of macros) listEl.appendChild(renderRow(m))
  }

  function renderRow(m) {
    const row = document.createElement('div')
    row.className = 'glass'
    row.style.cssText = 'padding:12px 14px;display:flex;flex-direction:column;gap:8px;'
    row.innerHTML = `
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:10px;">
        <div style="flex:1;min-width:0;">
          <div class="macro-name" style="font-size:13px;color:#FFE8C7;font-weight:500;line-height:1.3;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;" title="${escapeHtml(m.name)}">${escapeHtml(m.name)}</div>
          <div style="font-size:10px;color:rgba(255,232,199,0.40);margin-top:3px;">
            ${fmtDuration(m.duration_ms)} · ${m.event_count} events · ${fmtRelative(m.created_at)}
          </div>
        </div>
      </div>
      <div style="display:flex;gap:6px;flex-wrap:wrap;align-items:center;">
        <button class="btn btn-primary ai-run" style="flex:1;min-width:150px;font-size:11px;padding:6px 10px;">✦ Run in background</button>
        <button class="btn play" style="font-size:11px;padding:6px 10px;">▶ Replay</button>
        <select class="speed" title="Replay speed" style="font-size:11px;padding:6px 8px;background:rgba(0,0,0,0.30);color:#FFE8C7;border:1px solid rgba(228,175,122,0.30);border-radius:6px;cursor:pointer;">
          <option value="1">1×</option>
          <option value="2">2×</option>
          <option value="5">5×</option>
        </select>
        <button class="btn schedule" style="font-size:11px;padding:6px 10px;">Schedule</button>
        <button class="btn rename"   style="font-size:11px;padding:6px 10px;">Rename</button>
        <button class="btn del"      style="font-size:11px;padding:6px 10px;color:#F87171;">Delete</button>
      </div>
      <div class="sched-picker" style="display:none;gap:6px;align-items:center;flex-wrap:wrap;">
        <span style="font-size:11px;color:rgba(255,232,199,0.55);">Run at:</span>
        <input type="datetime-local" class="when" style="flex:1;min-width:170px;font-size:11px;padding:5px 8px;background:rgba(0,0,0,0.30);color:#FFE8C7;border:1px solid rgba(228,175,122,0.30);border-radius:6px;color-scheme:dark;" />
        <button class="btn btn-primary save-sched" style="font-size:11px;padding:5px 10px;">Save</button>
        <button class="btn cancel-sched"           style="font-size:11px;padding:5px 10px;">Cancel</button>
      </div>
      <div class="key-picker" style="display:none;gap:6px;align-items:center;flex-wrap:wrap;">
        <span style="font-size:11px;color:rgba(255,232,199,0.55);flex-basis:100%;">One-time setup: paste your Anthropic API key (console.anthropic.com → API keys). Stored only on this machine.</span>
        <input type="password" class="api-key" placeholder="sk-ant-…" style="flex:1;min-width:170px;font-size:11px;padding:5px 8px;background:rgba(0,0,0,0.30);color:#FFE8C7;border:1px solid rgba(228,175,122,0.30);border-radius:6px;" />
        <button class="btn btn-primary save-key" style="font-size:11px;padding:5px 10px;">Save & run</button>
      </div>
    `
    const speedSel = row.querySelector('.speed')
    const picker   = row.querySelector('.sched-picker')

    // Primary: hand the recording to the background agent. It recreates the
    // outcome with its own tools — screen and input stay free for the user.
    const startAiRun = async () => {
      const btn = row.querySelector('.ai-run')
      btn.disabled = true; btn.textContent = 'Starting…'
      const r = await window.electronAPI.macroAiRun(m.id, SUPABASE_ANON_KEY)
      btn.disabled = false; btn.textContent = '✦ Run in background'
      // First run on a machine with no Anthropic key: show the one-time
      // inline key form instead of an error.
      if (r?.error === 'need_key') { keyPicker.style.display = 'flex'; keyPicker.querySelector('.api-key').focus(); return }
      if (r?.error) { alert('Could not start: ' + r.error); return }
      bgAgentSteps = []; bgAgentTask = m.name + ' — background run'; bgAgentRunning = true
      view = { kind: 'agent-bg-running' }
      render()
    }
    const keyPicker = row.querySelector('.key-picker')
    row.querySelector('.ai-run').onclick = startAiRun
    keyPicker.querySelector('.save-key').onclick = async () => {
      const v = keyPicker.querySelector('.api-key').value.trim()
      if (!v) return
      await window.electronAPI.setSettings('anthropic_api_key', v)
      keyPicker.style.display = 'none'
      await startAiRun()
    }
    keyPicker.querySelector('.api-key').onkeydown = (e) => {
      if (e.key === 'Enter') keyPicker.querySelector('.save-key').click()
    }

    // Secondary: exact input replay (takes over mouse/keyboard until done).
    row.querySelector('.play').onclick = async () => {
      const btn = row.querySelector('.play')
      btn.disabled = true
      // Visible 3-2-1 countdown so the user's hands can leave the keyboard
      // before synthesized input starts flying. Scout's window also minimizes
      // (main.js macro:play handler) so the cursor isn't fighting our UI.
      for (let n = 3; n >= 1; n--) {
        btn.textContent = `Replay in ${n}…`
        await new Promise(r => setTimeout(r, 1000))
      }
      btn.textContent = '● Replaying…'
      const r = await window.electronAPI.macroPlay(m.id, { speed: Number(speedSel.value) || 1 })
      btn.disabled = false; btn.textContent = '▶ Replay'
      if (r?.error) alert('Playback failed: ' + r.error)
    }

    row.querySelector('.schedule').onclick = () => {
      // Toggle the picker. Default to "now + 15 minutes" rounded to the next 5.
      if (picker.style.display === 'flex') { picker.style.display = 'none'; return }
      const d = new Date(Date.now() + 15 * 60_000)
      d.setSeconds(0, 0)
      d.setMinutes(Math.ceil(d.getMinutes() / 5) * 5)
      row.querySelector('.when').value = toLocalDatetimeInput(d)
      picker.style.display = 'flex'
    }
    row.querySelector('.cancel-sched').onclick = () => { picker.style.display = 'none' }
    row.querySelector('.save-sched').onclick = async () => {
      const v = row.querySelector('.when').value
      if (!v) return
      const when = new Date(v).getTime()
      if (!when || when < Date.now()) { alert('Pick a time in the future.'); return }
      const r = await window.electronAPI.macroSchedule({
        macro_id: m.id, when, speed: Number(speedSel.value) || 1,
      })
      if (r?.error) { alert(r.error); return }
      picker.style.display = 'none'
      await reloadSchedules()
    }

    // window.prompt doesn't exist in Electron — edit the name in place instead.
    row.querySelector('.rename').onclick = () => {
      const nameEl = row.querySelector('.macro-name')
      const input = document.createElement('input')
      input.value = m.name
      input.style.cssText = 'width:100%;font-size:13px;padding:3px 6px;background:rgba(0,0,0,0.30);color:#FFE8C7;border:1px solid rgba(228,175,122,0.50);border-radius:6px;'
      nameEl.replaceWith(input)
      input.focus(); input.select()
      let done = false
      const commit = async (save) => {
        if (done) return; done = true
        const next = input.value.trim()
        if (save && next && next !== m.name) await window.electronAPI.macroRename(m.id, next)
        await reloadList()
      }
      input.onkeydown = (e) => {
        if (e.key === 'Enter') commit(true)
        else if (e.key === 'Escape') commit(false)
      }
      input.onblur = () => commit(true)
    }
    row.querySelector('.del').onclick = async () => {
      if (!confirm(`Delete "${m.name}"? This can't be undone.`)) return
      await window.electronAPI.macroDelete(m.id)
      await reloadList()
    }
    return row
  }

  async function reloadSchedules() {
    const all = await window.electronAPI.macroListSchedules?.() || []
    const pending = all.filter(s => s.status === 'pending' || s.status === 'running')
    const listEl  = schedWrap.querySelector('#sched-list')
    const countEl = schedWrap.querySelector('#sched-count')
    if (!pending.length) { schedWrap.style.display = 'none'; return }
    schedWrap.style.display = 'flex'
    countEl.textContent = `${pending.length} pending`
    listEl.innerHTML = ''
    for (const s of pending) {
      const r = document.createElement('div')
      r.className = 'glass'
      r.style.cssText = 'padding:9px 12px;display:flex;align-items:center;gap:10px;'
      const running = s.status === 'running'
      r.innerHTML = `
        <span style="width:8px;height:8px;border-radius:50%;flex-shrink:0;background:${running ? '#dc2626' : '#E4AF7A'};${running ? 'animation:pulse-dot 1s ease-in-out infinite;' : ''}"></span>
        <div style="flex:1;min-width:0;">
          <div style="font-size:12px;color:#FFE8C7;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;">${escapeHtml(s.macro_name)}</div>
          <div style="font-size:10px;color:rgba(255,232,199,0.45);margin-top:2px;">
            ${running ? '● Running now' : fmtUntil(s.when)} · ${s.speed || 1}× speed
          </div>
        </div>
        <button class="btn cancel" style="font-size:10px;padding:4px 8px;" ${running ? 'disabled' : ''}>Cancel</button>
      `
      r.querySelector('.cancel').onclick = async () => {
        await window.electronAPI.macroCancelSchedule(s.id)
        await reloadSchedules()
      }
      listEl.appendChild(r)
    }
  }

  // Record button: toggles state in the main process; we then re-render.
  // No-friction: auto-name on stop. User can rename later from the list.
  recBtn.onclick = async () => {
    if (macroState.recorder?.recording) {
      const auto = `Macro · ${new Date().toLocaleString()}`
      await window.electronAPI.macroStopRecording(auto)
      await reloadList()
    } else if (macroState.player?.playing) {
      await window.electronAPI.macroStopPlay()
    } else {
      const r = await window.electronAPI.macroStartRecording()
      if (r?.error) alert(r.error)
    }
  }

  // Initial paint + reload, then re-pulse every second so the elapsed counter ticks.
  window.electronAPI.macroGetState().then(s => { macroState = s; paintHeader() })
  void reloadList()
  void reloadSchedules()
  paintHeader()

  // Listen for schedule changes pushed from main (a scheduled run firing,
  // completing, or being cancelled from elsewhere) and re-paint.
  const offSched = (data) => { if (view.kind === 'idle' && view.tab === 'macros') reloadSchedules() }
  window.electronAPI.onMacroSchedules?.(offSched)

  const tick = setInterval(async () => {
    if (view.kind !== 'idle' || view.tab !== 'macros') { clearInterval(tick); clearInterval(schedTick); return }
    // While recording, pull fresh state so the event counter ticks live —
    // main only pushes macro:state on start/stop, not per captured event.
    if (macroState.recorder?.recording) {
      try { macroState = await window.electronAPI.macroGetState() } catch {}
    }
    paintHeader()
  }, 700)
  // Refresh "in N minutes" labels less often — minute resolution is plenty.
  const schedTick = setInterval(() => reloadSchedules(), 30_000)

  return d
}

// ---- Monitor tab ----

function monitorTab() {
  const d = document.createElement('div')
  d.style.cssText = 'padding:20px;display:flex;flex-direction:column;gap:16px;'

  d.innerHTML = `
    <div class="glass" style="padding:16px;display:flex;flex-direction:column;gap:12px;">
      <div style="display:flex;align-items:center;justify-content:space-between;">
        <div>
          <div class="display" style="font-size:18px;color:#E4AF7A;">Screen Monitor</div>
          <p style="font-size:11px;margin-top:5px;line-height:1.65;color:rgba(255,232,199,0.45);">Scout watches your screen in the background and captures what you do — ready to turn any session into a skill.</p>
        </div>
        <div id="monitor-status-dot" style="width:10px;height:10px;border-radius:50%;background:rgba(255,232,199,0.20);flex-shrink:0;margin-top:2px;transition:background 0.3s;"></div>
      </div>
      <button id="monitor-toggle-btn" class="btn btn-primary" style="width:100%;font-size:13px;padding:10px;">Start Monitor</button>
      <p style="font-size:10px;color:rgba(255,232,199,0.30);line-height:1.5;">Shortcut: <span style="font-family:'JetBrains Mono',monospace;background:rgba(182,128,57,0.12);padding:1px 5px;border-radius:3px;color:#E4AF7A;">Alt+Shift+M</span> from anywhere</p>
    </div>

    <div class="glass" style="padding:14px;display:flex;flex-direction:column;gap:8px;">
      <div style="display:flex;align-items:center;justify-content:space-between;">
        <div class="label" style="font-size:9px;">LIVE VIEW</div>
        <span id="monitor-frame-count" style="font-size:9px;color:rgba(255,232,199,0.28);">No frames yet</span>
      </div>
      <img id="monitor-live-img" style="display:none;width:100%;border-radius:6px;object-fit:cover;" />
      <div id="monitor-placeholder" style="height:120px;border-radius:6px;background:rgba(0,0,0,0.35);border:1px dashed rgba(182,128,57,0.18);display:flex;align-items:center;justify-content:center;">
        <span style="font-size:11px;color:rgba(255,232,199,0.25);">Start monitor to see live feed</span>
      </div>
    </div>

    <div class="glass" style="padding:14px;border-color:rgba(182,128,57,0.15);">
      <div class="label" style="font-size:9px;margin-bottom:8px;">HOW IT WORKS</div>
      <div style="display:flex;flex-direction:column;gap:7px;">
        <div style="display:flex;align-items:flex-start;gap:8px;"><span style="font-size:13px;">📸</span><span style="font-size:11px;line-height:1.6;color:rgba(255,232,199,0.50);">Takes a screenshot every 10 seconds — stores the last 30 (5 minutes of activity)</span></div>
        <div style="display:flex;align-items:flex-start;gap:8px;"><span style="font-size:13px;">🔒</span><span style="font-size:11px;line-height:1.6;color:rgba(255,232,199,0.50);">Frames stay on your machine — nothing is uploaded unless you choose to generate a skill</span></div>
        <div style="display:flex;align-items:flex-start;gap:8px;"><span style="font-size:13px;">✨</span><span style="font-size:11px;line-height:1.6;color:rgba(255,232,199,0.50);">Hit Record at any time to layer voice on top and build a full skill from the session</span></div>
      </div>
    </div>
  `

  const toggleBtn = d.querySelector('#monitor-toggle-btn')
  const statusDot = d.querySelector('#monitor-status-dot')
  const liveImg   = d.querySelector('#monitor-live-img')
  const placeholder = d.querySelector('#monitor-placeholder')

  void window.electronAPI.getMonitorStatus().then(s => {
    monitorActive = s.active
    toggleBtn.textContent  = monitorActive ? 'Stop Monitor' : 'Start Monitor'
    toggleBtn.className    = monitorActive ? 'btn' : 'btn btn-primary'
    statusDot.style.background = monitorActive ? '#4ADE80' : 'rgba(255,232,199,0.20)'
    if (s.active && s.frameCount > 0) {
      void window.electronAPI.getMonitorFrames().then(frames => {
        if (frames.length) {
          liveImg.src = frames[frames.length - 1].dataUrl
          liveImg.style.display = 'block'
          placeholder.style.display = 'none'
          d.querySelector('#monitor-frame-count').textContent = `${frames.length} frame${frames.length !== 1 ? 's' : ''} captured`
        }
      })
    }
  })

  toggleBtn.onclick = async () => {
    const next = !monitorActive
    await window.electronAPI.toggleMonitor({ active: next })
    monitorActive = next
    toggleBtn.textContent = next ? 'Stop Monitor' : 'Start Monitor'
    toggleBtn.className   = next ? 'btn' : 'btn btn-primary'
    statusDot.style.background = next ? '#4ADE80' : 'rgba(255,232,199,0.20)'
    if (!next) { liveImg.style.display = 'none'; placeholder.style.display = 'flex' }
  }

  // Live frame updates while this tab is visible
  window.electronAPI.onMonitorFrame(data => {
    liveImg.src = data.dataUrl
    liveImg.style.display = 'block'
    placeholder.style.display = 'none'
    d.querySelector('#monitor-frame-count').textContent = `${data.total} frame${data.total !== 1 ? 's' : ''} captured`
  })

  return d
}

// ---- Agent running view (renderer-side / legacy) ----

function agentRunningView(session) {
  const d = document.createElement('div')
  d.style.cssText = 'padding:16px 20px;display:flex;flex-direction:column;gap:12px;'

  const header = document.createElement('div')
  header.className = 'glass'
  header.style.cssText = 'padding:16px;'
  header.innerHTML = `
    <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:8px;">
      <div class="display" style="font-size:16px;color:#E4AF7A;line-height:1.3;flex:1;">${escapeHtml(session.task.slice(0, 80))}${session.task.length > 80 ? '…' : ''}</div>
      <button id="agent-stop" class="btn" style="font-size:11px;padding:5px 10px;flex-shrink:0;color:#F87171;border-color:rgba(248,113,113,0.3);">${session.done ? '← Library' : 'Stop'}</button>
    </div>
    <div id="agent-status" style="display:flex;align-items:center;gap:6px;">
      ${!session.done ? '<div style="width:6px;height:6px;border-radius:50%;background:#4ADE80;animation:pulse-dot-green 1.2s ease infinite;flex-shrink:0;"></div>' : '<div style="width:6px;height:6px;border-radius:50%;background:rgba(255,232,199,0.28);flex-shrink:0;"></div>'}
      <span style="font-size:10px;color:rgba(255,232,199,0.45);">${session.done ? `Completed in ${Math.round((session.elapsed||0)/1000)}s` : 'Agent running…'}</span>
    </div>
  `
  header.querySelector('#agent-stop').onclick = () => {
    if (session.done) { view = { kind: 'idle', tab: 'library' }; render(); return }
    session.stopped = true
    session.done = true
    session.elapsed = Date.now() - session.startedAt
    updateAgentView()
  }
  d.appendChild(header)

  const feedWrap = document.createElement('div')
  feedWrap.className = 'glass'
  feedWrap.style.cssText = 'padding:14px 16px;flex:1;min-height:300px;max-height:480px;overflow-y:auto;display:flex;flex-direction:column;gap:8px;'

  const streamText = document.createElement('div')
  streamText.id = 'agent-stream-text'
  streamText.style.cssText = 'font-size:12px;line-height:1.65;color:rgba(255,232,199,0.55);white-space:pre-wrap;font-style:italic;'

  const feed = document.createElement('div')
  feed.id = 'agent-feed'
  feed.style.cssText = 'display:flex;flex-direction:column;gap:8px;'

  feedWrap.appendChild(streamText)
  feedWrap.appendChild(feed)
  d.appendChild(feedWrap)

  const doneBar = document.createElement('div')
  doneBar.id = 'agent-done-bar'
  doneBar.style.cssText = `display:${session.done ? 'flex' : 'none'};gap:8px;`
  doneBar.innerHTML = `
    <button id="agent-view-skill" class="btn btn-primary" style="flex:1;font-size:12px;">View Skill →</button>
    <button id="agent-new" class="btn" style="flex:1;font-size:12px;">New Task</button>
  `
  doneBar.querySelector('#agent-view-skill').onclick = () => { view = { kind: 'idle', tab: 'library' }; render() }
  doneBar.querySelector('#agent-new').onclick = () => { agentSession = null; view = { kind: 'idle', tab: 'agent' }; render() }
  d.appendChild(doneBar)

  setTimeout(() => updateAgentView(), 0)
  return d
}

// ---- Credential review view ----

function agentCredReviewView(session, creds) {
  const d = document.createElement('div')
  d.style.cssText = 'padding:20px;display:flex;flex-direction:column;gap:14px;'

  d.innerHTML = `
    <div class="glass" style="padding:16px;">
      <div class="display" style="font-size:16px;color:#E4AF7A;margin-bottom:6px;">Credentials Detected</div>
      <p style="font-size:11px;line-height:1.65;color:rgba(255,232,199,0.50);">The agent encountered these credentials during the task. Save them to an encrypted <code style="font-family:monospace;background:rgba(182,128,57,0.12);padding:1px 4px;border-radius:3px;color:#E4AF7A;">.env</code> file?</p>
    </div>
  `

  const credList = document.createElement('div')
  credList.style.cssText = 'display:flex;flex-direction:column;gap:8px;'

  const approved = new Map()
  for (const cred of creds) {
    approved.set(cred.key, true)
    const card = document.createElement('div')
    card.className = 'glass'
    card.style.cssText = 'padding:12px 14px;'
    card.innerHTML = `
      <div style="display:flex;align-items:flex-start;justify-content:space-between;gap:8px;margin-bottom:6px;">
        <div>
          <div style="font-size:11px;font-family:'JetBrains Mono',monospace;color:#E4AF7A;">${escapeHtml(cred.key)}</div>
          <div style="font-size:10px;color:rgba(255,232,199,0.40);margin-top:2px;">${escapeHtml(cred.description || '')}</div>
        </div>
        <label style="display:flex;align-items:center;gap:6px;cursor:pointer;flex-shrink:0;">
          <input type="checkbox" data-key="${escapeHtml(cred.key)}" checked style="accent-color:#E4AF7A;width:14px;height:14px;cursor:pointer;">
          <span style="font-size:10px;color:rgba(255,232,199,0.45);">Save</span>
        </label>
      </div>
      <div style="font-size:10px;font-family:'JetBrains Mono',monospace;color:rgba(255,232,199,0.30);word-break:break-all;background:rgba(0,0,0,0.28);padding:5px 7px;border-radius:4px;">${escapeHtml((cred.value || '').slice(0, 60))}${(cred.value || '').length > 60 ? '…' : ''}</div>
    `
    card.querySelector('input').onchange = e => approved.set(cred.key, e.target.checked)
    credList.appendChild(card)
  }
  d.appendChild(credList)

  const envPathWrap = document.createElement('div')
  envPathWrap.className = 'glass'
  envPathWrap.style.cssText = 'padding:14px;'
  const defaultEnvPath = PLATFORM.defaultEnvPath(currentUser)
  envPathWrap.innerHTML = `
    <div class="label" style="font-size:9px;margin-bottom:6px;">SAVE TO FILE</div>
    <input id="env-path" class="input" type="text" value="${escapeHtml(defaultEnvPath)}" style="font-size:11px;font-family:'JetBrains Mono',monospace;width:100%;" />
    <p style="font-size:10px;margin-top:6px;color:rgba(255,232,199,0.30);line-height:1.5;">Existing keys are not overwritten. New keys are appended.</p>
  `
  d.appendChild(envPathWrap)

  const btnRow = document.createElement('div')
  btnRow.style.cssText = 'display:flex;gap:8px;'
  btnRow.innerHTML = `
    <button id="cred-save" class="btn btn-primary" style="flex:1;">Save to .env</button>
    <button id="cred-skip" class="btn" style="flex:1;">Skip</button>
  `
  btnRow.querySelector('#cred-save').onclick = async () => {
    const filePath = d.querySelector('#env-path').value.trim()
    if (!filePath) return
    const entries = creds.filter(c => approved.get(c.key)).map(c => ({ key: c.key, value: c.value }))
    if (entries.length) {
      const result = await window.electronAPI.agentSaveEnv({ filePath, entries })
      if (result?.error) { alert('Could not save .env: ' + result.error); return }
    }
    void generateSkillFromAgentSession()
  }
  btnRow.querySelector('#cred-skip').onclick = () => { void generateSkillFromAgentSession() }
  d.appendChild(btnRow)

  return d
}

// ---- Boot ----

function paintBootError(err) {
  try {
    const root = document.getElementById('app')
    if (!root) return
    const msg = String(err && (err.stack || err.message || err) || 'Unknown error')
    root.innerHTML = ''
    const d = document.createElement('div')
    d.style.cssText = 'display:flex;flex-direction:column;align-items:center;justify-content:center;height:100vh;padding:24px;text-align:center;font-family:-apple-system,Segoe UI,sans-serif;color:#FFD69C;'
    d.innerHTML = `
      <div style="font-family:'Bebas Neue',Impact,sans-serif;font-size:40px;color:#E4AF7A;letter-spacing:0.05em;">SCOUT</div>
      <div style="margin-top:18px;font-size:13px;color:#F87171;">Scout couldn't start.</div>
      <pre style="margin-top:14px;font-size:10px;text-align:left;max-width:420px;max-height:240px;overflow:auto;padding:10px;background:rgba(0,0,0,0.4);border:1px solid rgba(228,175,122,0.18);border-radius:6px;white-space:pre-wrap;">${msg.replace(/[<>&]/g, c => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;' }[c]))}</pre>
    `
    root.appendChild(d)
  } catch {}
}

window.addEventListener('error', e => paintBootError(e.error || e.message))
window.addEventListener('unhandledrejection', e => paintBootError(e.reason))

void (async () => {
  try {
    render()
  } catch (e) {
    paintBootError(e)
    return
  }

  try {
    await Promise.all([
      initSupabase(),
      new Promise(r => setTimeout(r, 800)),
    ])
  } catch (e) {
    console.error('Boot error:', e)
  }

  // No-auth mode — initSupabase always produces a currentUser; never show auth UI.
  view = { kind: 'idle', tab: 'record' }
  try { render() } catch (e) { paintBootError(e); return }

  // Subscribe to main-process events (agent updates, monitor frames, MCP ready)
  initMainProcessListeners()

  // Load initial state from main process
  window.electronAPI.getMCPStatus().then(s => { mcpStatus = s })
  window.electronAPI.getMonitorStatus().then(s => { monitorActive = s.active })
  window.electronAPI.macroGetState?.().then(s => { if (s) macroState = s })
  window.electronAPI.getAgentState().then(s => {
    if (s.running) { bgAgentRunning = true; bgAgentTask = s.task; view = { kind: 'agent-bg-running' }; render() }
  })

  // Global hotkey — toggles recording from anywhere on the desktop
  window.electronAPI.onHotkeyRecord(() => {
    if (view.kind === 'recording') {
      void doStopRecording()
    } else if (view.kind === 'idle') {
      if (view.tab !== 'record') { view = { kind: 'idle', tab: 'record' }; render() }
      setTimeout(() => startRecording(), 80)
    }
  })

  // Floating overlay buttons (always-on-top control bar)
  window.electronAPI.onOverlayStop?.(() => { if (view.kind === 'recording') void doStopRecording() })
  window.electronAPI.onOverlayPause?.(() => {
    if (view.kind !== 'recording' || !view.state._recorder) return
    view.state.is_paused = !view.state.is_paused
    if (view.state._recorder.state === 'recording') view.state._recorder.pause()
    else if (view.state._recorder.state === 'paused') view.state._recorder.resume()
    render()
  })
})()

})()

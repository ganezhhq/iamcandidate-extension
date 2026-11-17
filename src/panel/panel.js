import { api, ApiError } from "../lib/api.js"
import { fillPage, focusField } from "../lib/autofill.js"
import { WORK_MODES } from "../lib/constants.js"
import { extractPage } from "../lib/extract.js"
import { matchResume, totalYears } from "../lib/match.js"
import { LEARN_KEY, loadFillData } from "../lib/profile.js"
import { getReport, reportKey, saveReport } from "../lib/report.js"
import { RESUME_PREF_KEY, resumeFile } from "../lib/resume-file.js"
import {
  ANSWERS_KEY,
  AUTOFILL_KEY,
  AUTO_FILL_KEY,
  SESSION_KEY,
  getAutoFill,
  getSession,
  getSettings,
  recallJob,
  rememberJob,
  setAutoFill,
} from "../lib/storage.js"

/**
 * The autofill side panel: what job you're applying for, how your resume
 * matches it, and a field-by-field report after filling the form, with the
 * required questions still unanswered called out, and a button to save the
 * job to your applications once you've applied. It follows the active tab.
 */

/* ------------------------------------------------------------------ */
/* State                                                               */
/* ------------------------------------------------------------------ */

const state = {
  settings: undefined,
  session: undefined,
  tab: undefined,
  /** `{ role, company, location, workMode, jobId, jobUrl, description, site }` for the job on (or behind) this page. */
  job: undefined,
  /** Whether the extension can script the current page. */
  readable: false,
  resumes: [],
  resumeId: "",
  /** Your Skills tab, for the match score. */
  skills: [],
  /** For "Mark this job as applied": to reuse a company and spot a job saved before. */
  companies: [],
  applications: [],
  /** Your autofill details and saved answers, as the form filler reads them. */
  details: {},
  answers: {},
  running: false,
}

/** Asked for on the first Autofill click, so the panel keeps working as you move between pages. */
const SITE_ACCESS = { origins: ["https://*/*", "http://*/*"] }
/** Set when the panel runs in its own window (browsers without side panels):
 * the browser window whose active tab it works on. */
const pageWindowId = Number(new URLSearchParams(location.search).get("window")) || undefined

/* ------------------------------------------------------------------ */
/* DOM helpers                                                         */
/* ------------------------------------------------------------------ */

const $ = (id) => document.getElementById(id)
const VIEWS = ["view-loading", "view-signed-out", "view-main"]

function show(view) {
  for (const id of VIEWS) $(id).hidden = id !== view
}

function setAlert(el, message) {
  el.textContent = message ?? ""
  el.hidden = !message
}

function el(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props)
  node.append(...children.filter((child) => child !== undefined && child !== null))
  return node
}

const isHttpUrl = (value) => {
  try {
    return /^https?:$/.test(new URL(value).protocol)
  } catch {
    return false
  }
}

const userKey = () => state.session?.user?.id ?? state.session?.user?.email

/* ------------------------------------------------------------------ */
/* Boot                                                                */
/* ------------------------------------------------------------------ */

async function init() {
  show("view-loading")
  state.settings = await getSettings()
  state.session = await getSession()
  if (!state.session || (state.session.apiUrl && state.session.apiUrl !== state.settings.apiUrl)) {
    state.session = undefined
    $("site-chip").hidden = true
    return show("view-signed-out")
  }
  try {
    state.session = await api.refreshIfStale(state.session)
    await Promise.all([loadResumes(), loadDetails(), loadApplications()])
  } catch (error) {
    return handleError(error)
  }
  show("view-main")
  await Promise.all([renderAutoFill(), readTab()])
}

async function loadResumes() {
  const [resumes, skills, { [RESUME_PREF_KEY]: preferred }] = await Promise.all([
    api.listResumes().catch(() => []),
    api.listSkills().catch(() => []),
    chrome.storage.local.get(RESUME_PREF_KEY),
  ])
  state.resumes = resumes ?? []
  state.skills = skills ?? []
  const fallback = state.resumes.find((r) => r.isDefault) ?? state.resumes[0]
  state.resumeId = state.resumes.some((r) => r.id === preferred) ? preferred : (fallback?.id ?? "")
  const select = $("resume-select")
  select.replaceChildren(
    ...(state.resumes.length
      ? state.resumes.map((r) =>
          el("option", {
            value: r.id,
            textContent: `${r.title}${r.version ? ` (${r.version})` : ""}${r.isDefault ? " · default" : ""}`,
          }),
        )
      : [el("option", { value: "", textContent: "No resumes in IamCandidate" })]),
  )
  select.value = state.resumeId
  select.disabled = !state.resumes.length
}

async function loadApplications() {
  const [companies, applications] = await Promise.all([
    api.listCompanies().catch(() => []),
    api.listApplications().catch(() => []),
  ])
  state.companies = companies ?? []
  state.applications = applications ?? []
}

/** Your details and answers from IamCandidate (the copy on this device when offline). */
async function loadDetails() {
  const { details, answers } = await loadFillData(userKey())
  state.details = details
  state.answers = answers
  renderDetails()
  // Your total years feed the match.
  renderMatch()
}

/* ------------------------------------------------------------------ */
/* The page                                                            */
/* ------------------------------------------------------------------ */

/** Reads the job on the active tab. An application form usually lacks the
 * description, so the posting read earlier in this tab fills the gaps. */
async function readTab() {
  const [tab] = await chrome.tabs.query(
    pageWindowId ? { active: true, windowId: pageWindowId } : { active: true, currentWindow: true },
  )
  const changed = tab?.id !== state.tab?.id || tab?.url !== state.tab?.url
  state.tab = tab
  if (changed && !state.running) $("run-card").hidden = true
  setAlert($("main-error"), "")

  let page
  state.readable = false
  if (tab?.id && isHttpUrl(tab.url)) {
    try {
      // Every frame: career sites often embed the posting (Greenhouse, Lever,
      // Ashby…) in an iframe, and the description lives there, not on the page.
      const results = await chrome.scripting.executeScript({ target: { tabId: tab.id, allFrames: true }, func: extractPage })
      page = bestPage(results)
      state.readable = true
    } catch {
      // No access to this site yet: granted on the first Autofill click.
    }
  }

  const here = page?.job ?? {}
  // A heading or a one-line snippet isn't a posting: keep using the full one read earlier.
  const fullPosting = text(here.description).length >= MIN_DESCRIPTION
  if (page?.kind === "job" && fullPosting) await rememberJob(tab.id, { ...here, site: page.site })
  const earlier = fullPosting ? undefined : await recallJob(tab?.id)
  const role = cleanRole(here.role)
  // The posting's own link beats the application form's, which is often a one-off.
  const pick = (key) => here[key] || earlier?.[key] || ""
  const description = [here.description, earlier?.description].map(text).sort((a, b) => b.length - a.length)[0] ?? ""
  state.job = {
    role: role || cleanRole(earlier?.role),
    company: pick("company"),
    location: pick("location"),
    workMode: pick("workMode"),
    jobId: pick("jobId"),
    jobUrl: (fullPosting ? here.jobUrl : earlier?.jobUrl) || here.jobUrl || (isHttpUrl(tab?.url) ? tab.url : ""),
    description,
    site: page?.site || earlier?.site || hostOf(tab?.url),
  }
  if (changed) closeAppliedForm()
  renderJob()
  renderMatch()
  await showStoredReport()
}

/** Shorter than this, a "description" is a heading or snippet, too little to score a resume against. */
const MIN_DESCRIPTION = 200

/**
 * One reading of the page from every frame's: the top frame's, with the job
 * from whichever frame holds the fullest posting (an embedded job board).
 * A LinkedIn profile in the top frame wins outright.
 */
function bestPage(results) {
  const pages = (results ?? []).filter((r) => r?.result)
  const top = pages.find((r) => r.frameId === 0)?.result ?? pages[0]?.result
  if (!top || top.kind === "profile") return top
  const richest = pages
    .map((r) => r.result)
    .filter((p) => p.kind === "job" && p.job)
    .sort((a, b) => text(b.job.description).length - text(a.job.description).length)[0]
  if (!richest || richest === top) return top
  // Fields the embedded posting lacks come from the page around it.
  const job = { ...top.job }
  for (const [key, value] of Object.entries(richest.job)) if (text(value)) job[key] = value
  return { ...top, kind: "job", job, site: richest.site || top.site }
}

/** The last fill in this tab (often the automatic one), unless one is running now. */
async function showStoredReport() {
  if (state.running || !state.tab?.id) return
  const report = await getReport(state.tab.id, state.tab.url)
  if (!report) return
  $("run-card").hidden = false
  renderResults(report.fields, undefined, { auto: report.auto })
}

/** "Application: Full-Stack Engineer" → "Full-Stack Engineer". */
const cleanRole = (role) =>
  String(role ?? "")
    .replace(/^(job )?application( form)?\s*(for|:|-|–)\s*/i, "")
    .replace(/^apply( now)?( for)?\s*(:|-|–)?\s*/i, "")
    .trim()

function hostOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "")
  } catch {
    return ""
  }
}

function renderJob() {
  const { job, tab } = state
  const fillable = tab?.id && isHttpUrl(tab.url)
  const chip = $("site-chip")
  chip.textContent = hostOf(tab?.url)
  chip.title = tab?.url ?? ""
  chip.hidden = !chip.textContent

  $("job-role").textContent = job.role || (fillable ? "This page" : "Nothing to fill here")
  $("job-meta").textContent = fillable
    ? [job.company, job.site].filter(Boolean).join(" · ") ||
      (state.readable ? "No job details found on this page" : "Click Autofill to read this page")
    : "Open a job's application form to autofill it."
  $("job-mark").textContent = (job.company || job.role || job.site || "?").trim().charAt(0).toUpperCase()
  $("btn-autofill").disabled = !fillable || state.running
  renderApplied()
}

/* ------------------------------------------------------------------ */
/* Resume match                                                        */
/* ------------------------------------------------------------------ */

const currentResume = () => state.resumes.find((r) => r.id === state.resumeId)

function renderMatch() {
  const resume = currentResume()
  $("resume-edit").hidden = !resume
  $("resume-file").textContent = !resume
    ? "Add a resume in IamCandidate to see how it matches each job."
    : resume.documentId
      ? "Its file is attached when the form asks for a resume."
      : "No file saved with this resume, so you'll attach it on the form yourself."

  const result = matchResume(resume, state.job?.description, state.skills, totalYears(state.details))
  $("match").hidden = !result
  $("match-keywords").hidden = !result
  $("match-experience").hidden = !result?.experience
  $("match-empty").hidden = (!resume && !state.skills.length) || !!result
  if (!result) {
    const fillable = state.tab?.id && isHttpUrl(state.tab.url)
    $("match-empty").textContent = !state.readable && fillable
      ? "IamCandidate can't read this page yet. Click Autofill once to allow it, and the score appears."
      : text(state.job?.description).length >= 40
        ? "This job doesn't name skills we can compare."
        : "No job description found here. Open the job posting (or scroll it into view) and press refresh."
    return
  }

  const { score, matched, missing, years, experience } = result
  // Overall experience: "5+ years of experience" against your total.
  const line = $("match-experience")
  if (experience) {
    const { asked, have } = experience
    line.dataset.tone = !have ? "unknown" : have >= asked ? "met" : "short"
    line.replaceChildren(
      el("span", { className: "strong", textContent: `Experience: asks ${asked}+ yrs` }),
      ` · ${!have ? "add your total years on the Autofill page" : `you have ${have} (${have >= asked ? "meets it" : `${Math.round((asked - have) * 10) / 10} short`})`}`,
    )
  }
  const tone = score >= 75 ? "good" : score >= 50 ? "fair" : "low"
  $("match").dataset.tone = tone
  $("match-score").textContent = String(score)
  const circumference = 2 * Math.PI * 18
  const arc = $("match-arc")
  arc.style.strokeDasharray = `${circumference}`
  arc.style.strokeDashoffset = `${circumference * (1 - score / 100)}`
  $("match-title").textContent =
    tone === "good" ? "Strong match" : tone === "fair" ? "Partial match" : "Weak match"
  const total = matched.length + missing.length
  const short = years.filter((y) => y.have && y.have < y.asked)
  $("match-detail").textContent = [
    `You have ${matched.length} of ${total} skills this job names`,
    years.length ? `${short.length ? `${short.length} below` : "meets"} the years it asks` : "",
  ]
    .filter(Boolean)
    .join(" · ")
  const asked = new Map(years.map((y) => [y.name, y]))
  const yearsNote = (y) =>
    !y ? "" : !y.have ? `Asks ${y.asked}+ yrs; add your years in Skills` : `Asks ${y.asked}+ yrs; you have ${y.have}`
  $("keyword-list").replaceChildren(
    ...missing.map((name) => el("li", { className: "missing", textContent: name, title: "Not on your resume or in your Skills" })),
    ...matched.map((name) => {
      const y = asked.get(name)
      return el("li", {
        className: y?.have && y.have < y.asked ? "short" : "matched",
        textContent: y ? `${name} · ${y.asked}+ yrs` : name,
        title: yearsNote(y) || "On your resume or in your Skills",
      })
    }),
  )
}

/* ------------------------------------------------------------------ */
/* Autofill                                                            */
/* ------------------------------------------------------------------ */

function setSteps(steps) {
  $("run-steps").replaceChildren(
    ...steps.map(({ label, status }) =>
      el(
        "li",
        { className: `step ${status}` },
        el("span", { className: "step-icon", ariaHidden: "true" }),
        el("span", { textContent: label }),
      ),
    ),
  )
}

async function runAutofill(access) {
  const tab = state.tab
  if (!tab?.id || !isHttpUrl(tab.url) || state.running) return
  state.running = true
  renderJob()
  setAlert($("main-error"), "")
  $("run-card").hidden = false
  $("run-results").hidden = true
  $("run-title").textContent = "Autofilling this page…"

  const resume = currentResume()
  const fetching = { label: "Getting your resume file", status: "active" }
  const filling = { label: "Finding the questions and filling your answers", status: "pending" }
  const steps = resume?.documentId ? [fetching, filling] : [filling]
  setSteps(steps)

  try {
    await access.catch(() => false)
    const [{ file, skipped }] = await Promise.all([resumeFile(resume), loadDetails()])
    fetching.status = file ? "done" : "skipped"
    filling.status = "active"
    setSteps(steps)

    // Application forms are often embedded in an iframe (Greenhouse, Lever…);
    // frames Chrome won't let us into are skipped.
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      func: fillPage,
      args: [state.details, state.answers, { userId: userKey(), learnKey: LEARN_KEY }, file],
    })
    const fields = results.flatMap((r) => (r?.result?.fields ?? []).map((field) => ({ ...field, frameId: r.frameId })))
    await saveReport(tab.id, tab.url, fields)
    renderResults(fields, skipped)
    if (!state.readable) await readTab()
  } catch (error) {
    console.warn("IamCandidate: could not fill the page", error)
    $("run-card").hidden = true
    setAlert($("main-error"), "This page can't be filled by extensions. Allow IamCandidate to read this site and try again.")
  } finally {
    state.running = false
    renderJob()
  }
}

function renderResults(fields, note, { auto = false } = {}) {
  $("run-steps").replaceChildren()
  $("run-results").hidden = false

  if (!fields.length) {
    $("run-title").textContent = "No form questions found on this page"
    $("required-count").textContent = ""
    $("required-list").replaceChildren()
    $("required-none").hidden = true
    $("run-optional").hidden = true
    $("run-meter").style.width = "0%"
    return
  }

  const answered = (f) => f.status !== "empty"
  const required = fields.filter((f) => f.required)
  const optional = fields.filter((f) => !f.required)
  const open = required.filter((f) => !answered(f)).length
  const done = auto ? "Filled automatically" : "Done"
  $("run-title").textContent = !required.length
    ? `${done} — ${fields.filter((f) => f.status === "filled").length} questions`
    : open
      ? `${done} — ${open} required question${open === 1 ? "" : "s"} need${open === 1 ? "s" : ""} you`
      : `${done} — every required question is answered`
  $("run-meter").style.width = `${required.length ? (100 * (required.length - open)) / required.length : 100}%`
  $("required-count").textContent = required.length
    ? `(${required.length - open} of ${required.length} answered)`
    : ""
  $("required-none").hidden = required.length > 0
  $("required-list").replaceChildren(...required.map(fieldRow))
  $("run-optional").hidden = !optional.length
  $("optional-count").textContent = `(${optional.filter(answered).length} of ${optional.length} answered)`
  $("optional-list").replaceChildren(...optional.map(fieldRow))
  if (note) setAlert($("main-error"), note)
}

const STATUS_TEXT = {
  filled: "Filled by IamCandidate",
  had: "Already answered",
  empty: "Needs your answer",
}

function fieldRow(field, index) {
  const button = el(
    "button",
    { type: "button", className: `field-row ${field.status}`, title: `${STATUS_TEXT[field.status]} — click to jump to it` },
    el("span", { className: "field-icon", ariaHidden: "true" }),
    el("span", { className: "field-label", textContent: field.label }),
    field.status === "empty" ? el("span", { className: "field-tag", textContent: "Answer" }) : undefined,
  )
  button.style.animationDelay = `${Math.min(index, 20) * 35}ms`
  button.addEventListener("click", async () => {
    try {
      await chrome.scripting.executeScript({
        target: { tabId: state.tab.id, frameIds: [field.frameId ?? 0] },
        func: focusField,
        args: [field.id],
      })
    } catch {
      // The page changed since; nothing to jump to.
    }
  })
  return el("li", {}, button)
}

/* ------------------------------------------------------------------ */
/* Mark as applied                                                     */
/* ------------------------------------------------------------------ */

const appliedForm = () => $("applied-form")
const appliedField = (name) => appliedForm().elements.namedItem(name)

/** "Acme Inc." and "ACME" are the same company. */
const norm = (value) =>
  String(value ?? "")
    .toLowerCase()
    .replace(/[.,&()'"]/g, " ")
    .replace(/\b(inc|llc|ltd|limited|pvt|private|corp|corporation|co|gmbh|plc|llp|the)\b/g, " ")
    .replace(/\s+/g, " ")
    .trim()

const normUrl = (value) => {
  try {
    const url = new URL(value)
    return `${url.hostname.replace(/^www\./, "")}${url.pathname.replace(/\/+$/, "")}`.toLowerCase()
  } catch {
    return ""
  }
}

const findCompany = (name) => {
  const key = norm(name)
  return key ? state.companies.find((c) => norm(c.name) === key) : undefined
}
const companyName = (id) => state.companies.find((c) => c.id === id)?.name ?? ""

/** This job, if it's already in your applications: same link, or same role at the same company. */
function savedApplication() {
  const { jobUrl, role, company } = state.job ?? {}
  const url = normUrl(jobUrl)
  const companyId = findCompany(company)?.id
  return state.applications.find(
    (a) =>
      (url && normUrl(a.jobUrl) === url) ||
      (companyId && a.companyId === companyId && norm(a.role) === norm(role)),
  )
}

function renderApplied() {
  const fillable = state.tab?.id && isHttpUrl(state.tab.url)
  const saved = fillable ? savedApplication() : undefined
  const done = $("applied-done")
  done.replaceChildren()
  done.hidden = !saved
  $("btn-applied").hidden = !fillable || !!saved || !appliedForm().hidden
  if (!saved) return
  const company = companyName(saved.companyId)
  done.append(`In your applications: ${saved.role}${company ? ` at ${company}` : ""}. `)
  const open = el("button", { type: "button", className: "link", textContent: "Open it" })
  open.addEventListener("click", () =>
    chrome.tabs.create({ url: `${state.settings.appUrl}/career/applications/${encodeURIComponent(saved.id)}` }),
  )
  done.append(open)
}

/** Saves right away when the page named the role, company and work mode; otherwise asks for what's missing. */
function markApplied() {
  const { role = "", company = "", workMode = "" } = state.job ?? {}
  if (role && company && workMode) return saveApplied({ role, company, workMode })
  const form = appliedForm()
  form.hidden = false
  $("btn-applied").hidden = true
  appliedField("role").value = role
  appliedField("company").value = company
  appliedField("workMode").value = workMode
  for (const name of ["role", "company", "workMode"]) {
    appliedField(name).closest(".field").classList.toggle("missing", !appliedField(name).value)
  }
  ;(["role", "company", "workMode"].map(appliedField).find((input) => !input.value) ?? appliedField("role")).focus()
}

function closeAppliedForm() {
  appliedForm().hidden = true
  for (const field of appliedForm().querySelectorAll(".field")) field.classList.remove("missing", "invalid")
}

async function saveApplied(values) {
  const button = appliedForm().hidden ? $("btn-applied") : $("applied-save")
  const label = button.textContent
  button.disabled = true
  button.textContent = "Saving…"
  setAlert($("main-error"), "")
  try {
    let companyId = findCompany(values.company)?.id
    if (!companyId) {
      const created = await api.createCompany({
        name: values.company,
        industry: "",
        website: "",
        location: "",
        size: "",
        status: "active",
        description: "",
        notes: "",
      })
      state.companies.push(created)
      companyId = created.id
    }
    const job = state.job ?? {}
    const input = {
      companyId,
      role: values.role,
      location: job.location ?? "",
      workMode: values.workMode,
      status: "applied",
      priority: "medium",
      notes: "",
    }
    if (isHttpUrl(job.jobUrl)) input.jobUrl = job.jobUrl
    if (job.jobId) input.jobId = job.jobId
    if (job.site) input.source = job.site
    if (job.description) input.description = job.description
    if (state.resumeId) input.resumeId = state.resumeId
    const application = await api.createApplication(input)
    state.applications.unshift(application)
    // What you typed is what this job is called from now on.
    state.job = { ...job, role: values.role, company: values.company, workMode: values.workMode }
    closeAppliedForm()
    renderJob()
  } catch (error) {
    handleError(error)
  } finally {
    button.disabled = false
    button.textContent = label
  }
}

function submitApplied(event) {
  event.preventDefault()
  const values = {
    role: appliedField("role").value.trim(),
    company: appliedField("company").value.trim(),
    workMode: appliedField("workMode").value,
  }
  const missing = Object.keys(values).filter((name) => !values[name])
  for (const name of Object.keys(values)) {
    appliedField(name).closest(".field").classList.toggle("invalid", missing.includes(name))
  }
  if (missing.length) {
    appliedField(missing[0]).focus()
    return
  }
  void saveApplied(values)
}

/* ------------------------------------------------------------------ */
/* Automatic filling                                                   */
/* ------------------------------------------------------------------ */

async function renderAutoFill() {
  const [on, access] = await Promise.all([getAutoFill(), chrome.permissions.contains(SITE_ACCESS)])
  const toggle = $("auto-toggle")
  toggle.checked = on && access
  $("auto-hint").textContent = !toggle.checked
    ? "Off. Click Autofill on each form yourself."
    : "Application forms are filled as soon as they open. Nothing is ever submitted."
}

/* ------------------------------------------------------------------ */
/* Your details                                                        */
/* ------------------------------------------------------------------ */

const text = (value) => String(value ?? "").trim()
const yesNo = (value) => ({ yes: "Yes", no: "No" })[text(value).toLowerCase()] ?? text(value)

/** One line for a postal address: "12 Main St, Chennai, Tamil Nadu 600001, India". */
const fullAddress = (d) =>
  [text(d.addressLine), text(d.city), [text(d.state), text(d.postalCode)].filter(Boolean).join(" "), text(d.country)]
    .filter(Boolean)
    .join(", ")

/** "2021-03" → "Mar 2021". */
const monthYear = (yearMonth) => {
  const [, y, m] = text(yearMonth).match(/^(\d{4})-(\d{2})$/) ?? []
  return y ? `${new Date(Number(y), Number(m) - 1).toLocaleString(undefined, { month: "short" })} ${y}` : text(yearMonth)
}

/**
 * Everything saved on the Autofill page, grouped as there. Each row is
 * `[label, read]`; `long` rows (summary, cover letter) show a few lines.
 */
const DETAIL_GROUPS = [
  {
    title: "Personal",
    rows: [
      ["First name", (d) => d.firstName],
      ["Last name", (d) => d.lastName],
      ["Full name", (d) => d.fullName],
      ["Preferred name", (d) => d.preferredName],
      ["Email", (d) => d.email],
      ["Phone", (d) => d.phone],
      ["Pronouns", (d) => d.pronouns],
    ],
  },
  {
    title: "Address",
    rows: [
      ["Address", (d) => d.addressLine],
      ["City", (d) => d.city],
      ["State", (d) => d.state],
      ["Postal code", (d) => d.postalCode],
      ["Country", (d) => d.country],
      ["Full address", fullAddress],
    ],
  },
  {
    title: "Links",
    rows: [
      ["LinkedIn", (d) => d.linkedin],
      ["GitHub", (d) => d.github],
      ["Portfolio", (d) => d.portfolio],
    ],
  },
  {
    title: "Work",
    rows: [
      ["Current title", (d) => d.currentTitle],
      ["Current company", (d) => d.currentCompany],
      ["Years of experience", (d) => text(d.experienceYears) || (totalYears(d) ? `${totalYears(d)} (from your work history)` : "")],
      ["Notice period", (d) => d.noticePeriod],
      ["Current salary", (d) => d.currentSalary],
      ["Expected salary", (d) => d.expectedSalary],
    ],
  },
  {
    title: "Work authorization",
    rows: [
      ["Authorized to work", (d) => yesNo(d.workAuthorization)],
      ["Needs sponsorship", (d) => yesNo(d.needsSponsorship)],
      ["Willing to relocate", (d) => yesNo(d.willingToRelocate)],
    ],
  },
  {
    title: "Education",
    rows: [
      ["School", (d) => d.school],
      ["Degree", (d) => d.degree],
      ["Field of study", (d) => d.fieldOfStudy],
      ["Graduation year", (d) => d.graduationYear],
    ],
  },
  {
    title: "Voluntary questions",
    rows: [
      ["Gender", (d) => d.gender],
      ["Ethnicity", (d) => d.ethnicity],
      ["Disability", (d) => d.disability],
      ["Veteran", (d) => d.veteran],
    ],
  },
  {
    title: "About you",
    rows: [
      ["Summary", (d) => d.summary, { long: true }],
      ["Cover letter", (d) => d.coverLetter, { long: true }],
    ],
  },
]

/** Your work history as label/value rows: "Engineer at Acme" → "Mar 2021 – Present · Chennai\n…". */
function workHistoryRows(details) {
  const jobs = Array.isArray(details.experience) ? details.experience : []
  return jobs.map((job) => {
    const dates = [monthYear(job.startDate), job.current ? "Present" : monthYear(job.endDate)].filter(Boolean).join(" – ")
    const head = [text(job.title), text(job.company)].filter(Boolean).join(" at ") || "Job"
    const meta = [dates, text(job.location)].filter(Boolean).join(" · ")
    return [head, () => [meta, text(job.description)].filter(Boolean).join("\n"), { long: true }]
  })
}

/** Copies on click and says so for a moment. */
function copyButton(value, label = "Copy") {
  const button = el("button", { type: "button", className: "copy-btn", textContent: label, title: "Copy to clipboard" })
  button.addEventListener("click", async () => {
    try {
      await navigator.clipboard.writeText(value)
      button.textContent = "Copied"
      button.classList.add("copied")
    } catch {
      button.textContent = "Couldn't copy"
    }
    setTimeout(() => {
      button.textContent = label
      button.classList.remove("copied")
    }, 1400)
  })
  return button
}

/** Every detail as plain text, for "Copy all". */
let detailsAsText = ""

function renderDetails() {
  const details = state.details ?? {}
  const groups = [...DETAIL_GROUPS, { title: "Work history", rows: workHistoryRows(details) }]
  const lines = []
  let filled = 0
  let total = 0

  $("details-groups").replaceChildren(
    ...groups
      .filter((group) => group.rows.length)
      .map((group) => {
        lines.push(`${group.title}`)
        const rows = group.rows.flatMap(([label, read, { long = false } = {}]) => {
          const value = text(read(details))
          // "Full address" and "Full name" repeat other rows, so they don't count.
          if (!/^Full /.test(label) && group.title !== "Work history") {
            total += 1
            if (value) filled += 1
          }
          if (value) lines.push(`${label}: ${value}`)
          return [
            el("dt", { textContent: label }),
            el("dd", { textContent: value || "Not set", className: [value ? "" : "empty", long && value ? "long" : ""].join(" ").trim(), title: value }),
            value ? copyButton(value) : el("span", { className: "copy-spacer" }),
          ]
        })
        lines.push("")
        return el(
          "section",
          {},
          el("p", { className: "details-group-title", textContent: group.title }),
          el("dl", { className: "details-list" }, ...rows),
        )
      }),
  )
  detailsAsText = lines.join("\n").trim()
  $("details-copy-all").hidden = !filled
  $("details-count").textContent = total
    ? `${filled} of ${total} details filled in. Questions without one are left for you on each form.`
    : ""

  const entries = Object.values(state.answers).sort((a, b) => (b.savedAt ?? 0) - (a.savedAt ?? 0))
  $("answers-count").textContent = entries.length ? `· ${entries.length}` : ""
  $("answers-empty").hidden = entries.length > 0
  $("answers-list").replaceChildren(
    ...entries.map((answer) =>
      el(
        "li",
        {},
        el(
          "div",
          { className: "answer-text" },
          el("p", { className: "strong", textContent: answer.label, title: answer.label }),
          el("p", { className: "muted", textContent: answer.value, title: answer.value }),
        ),
        text(answer.value) ? copyButton(text(answer.value)) : undefined,
      ),
    ),
  )
}

function openAutofillPage() {
  chrome.tabs.create({ url: `${state.settings.appUrl}/career/autofill` })
}

/* ------------------------------------------------------------------ */
/* Shared                                                              */
/* ------------------------------------------------------------------ */

function setTab(name) {
  $("tab-autofill").setAttribute("aria-selected", String(name === "autofill"))
  $("tab-details").setAttribute("aria-selected", String(name === "details"))
  $("pane-autofill").hidden = name !== "autofill"
  $("pane-details").hidden = name !== "details"
}

function handleError(error) {
  console.error("iamcandidate:", error)
  if (error instanceof ApiError && error.status === 401) {
    state.session = undefined
    return show("view-signed-out")
  }
  show("view-main")
  setAlert($("main-error"), error instanceof Error ? error.message : String(error))
}

/* ------------------------------------------------------------------ */
/* Events                                                              */
/* ------------------------------------------------------------------ */

let readTimer
/** Tabs fire several updates per navigation; read the page once it settles. */
function scheduleRead() {
  clearTimeout(readTimer)
  readTimer = setTimeout(() => {
    if (state.session) void readTab()
  }, 300)
}

function wireEvents() {
  $("tab-autofill").addEventListener("click", () => setTab("autofill"))
  $("tab-details").addEventListener("click", () => setTab("details"))
  $("btn-refresh").addEventListener("click", () => (state.session ? readTab() : init()))

  appliedField("workMode").replaceChildren(
    el("option", { value: "", textContent: "Choose…" }),
    ...WORK_MODES.map(({ value, label }) => el("option", { value, textContent: label })),
  )
  $("btn-applied").addEventListener("click", markApplied)
  appliedForm().addEventListener("submit", submitApplied)
  $("applied-cancel").addEventListener("click", () => {
    closeAppliedForm()
    renderApplied()
  })

  $("btn-autofill").addEventListener("click", () => {
    // Before any await: Chrome only asks for permissions during a click.
    const access = chrome.permissions.request(SITE_ACCESS)
    void runAutofill(access)
  })

  $("auto-toggle").addEventListener("change", (event) => {
    const on = event.target.checked
    // Before any await: Chrome only asks for permissions during a click.
    const access = on ? chrome.permissions.request(SITE_ACCESS) : Promise.resolve(true)
    void access
      .catch(() => false)
      .then((granted) => setAutoFill(on && granted))
      .then(renderAutoFill)
  })

  $("resume-select").addEventListener("change", (event) => {
    state.resumeId = event.target.value
    void chrome.storage.local.set({ [RESUME_PREF_KEY]: state.resumeId })
    renderMatch()
  })
  $("resume-edit").addEventListener("click", () => {
    if (state.resumeId) {
      chrome.tabs.create({ url: `${state.settings.appUrl}/career/resumes/${encodeURIComponent(state.resumeId)}` })
    }
  })

  $("details-edit").addEventListener("click", openAutofillPage)
  $("details-copy-all").addEventListener("click", async (event) => {
    const button = event.currentTarget
    try {
      await navigator.clipboard.writeText(detailsAsText)
      button.textContent = "Copied"
    } catch {
      button.textContent = "Couldn't copy"
    }
    setTimeout(() => (button.textContent = "Copy all"), 1400)
  })
  // Coming back from IamCandidate: details edited, applications or skills added or removed.
  window.addEventListener("focus", () => {
    if (state.session && !state.running) {
      void loadDetails().catch(() => {})
      void loadApplications().then(renderApplied)
      void api
        .listSkills()
        .then((skills) => {
          state.skills = skills ?? []
          renderMatch()
        })
        .catch(() => {})
    }
  })

  chrome.tabs.onActivated.addListener(scheduleRead)
  chrome.tabs.onUpdated.addListener((tabId, change) => {
    if (tabId === state.tab?.id && (change.status === "complete" || change.url)) scheduleRead()
  })
  chrome.windows.onFocusChanged.addListener(scheduleRead)

  chrome.storage.onChanged.addListener((changes, area) => {
    // The background worker filled this tab's form.
    if (area === "session" && state.tab?.id && changes[reportKey(state.tab.id)]?.newValue) {
      void showStoredReport()
    }
    if (area !== "local") return
    if (changes[AUTO_FILL_KEY]) void renderAutoFill()
    // Signing in or out in the popup.
    if (changes[SESSION_KEY]) {
      void init()
      return
    }
    if (!state.session) return
    // Refreshed from IamCandidate, e.g. after answers you typed on a form were saved there.
    if (changes[ANSWERS_KEY]) {
      const saved = changes[ANSWERS_KEY].newValue
      state.answers = saved?.userId === userKey() ? (saved.answers ?? {}) : {}
      renderDetails()
    }
    if (changes[AUTOFILL_KEY]) {
      const saved = changes[AUTOFILL_KEY].newValue
      state.details = saved?.userId === userKey() ? (saved.details ?? {}) : {}
      renderDetails()
      renderMatch()
    }
  })
}

wireEvents()
init().catch(handleError)

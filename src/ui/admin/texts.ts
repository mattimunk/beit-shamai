import { useT } from "../context";
import type { Lang } from "../../i18n/strings";

const he = {
  nav: { home: "לוח בקרה", properties: "נכסים", users: "משתמשים", reports: "דוחות", settings: "הגדרות", back: "→ חזרה" },
  greet: (h: number): string => (h < 12 ? "בוקר טוב" : h < 17 ? "צהריים טובים" : "ערב טוב"),
  summary: {
    lead: "מה מחכה לך היום:",
    newProps: (n: number) => `${n} נכסים חדשים ממתינים לבדיקה`,
    newUsers: (n: number) => `${n} משתמשים חדשים השבוע`,
    urgent: (n: number) => `${n} משימות דחופות`,
    market: (n: number) => `${n} נכסים ממתינים לעסקאות מרשות המסים`,
    approve: (n: number) => `${n} הערכות ממתינות לאישורך`,
    full: (n: number) => `${n} בקשות לשומה מלאה`,
    stale: (n: number, d: number) => `${n} נכסים ממתינים יותר מ-${d} ימים`,
    calm: "אין משימות דחופות. זמן טוב לעבור על נכסים שממתינים ללקוח.",
    first: "כדאי להתחיל ב:",
  },
  emailOff: (n: number) => `שליחת דוא״ל עדיין לא מחוברת – ${n} הודעות לא נשלחו. הן שמורות ויישלחו כשתחברו שירות (הגדרות).`,
  stats: {
    users: "משתמשים רשומים", usersNew: (t: number, w: number) => `${t} היום · ${w} השבוע`, properties: "נכסים", drafts: (n: number) => `${n} בטיוטה`,
    newSubmissions: "חדשים לבדיקה", attention: "דורשים טיפול", awaitingMarket: "ממתינים לנתוני רשות המסים", awaitingDocs: "ממתינים למסמכים מהלקוח",
    readyForPrelim: "מוכנים להערכה ראשונית", prelimAwaitingApproval: "הערכות ממתינות לאישור", prelimDelivered: "הערכות ראשוניות שנמסרו",
    fullRequested: "שומות מלאות שהוזמנו", fullInProgress: "שומות מלאות בעבודה", completed: "שומות מלאות שהושלמו",
  },
  queue: {
    title: "משימות לטיפול", mine: "שלי", all: "הכול", waiting: "ממתין ללקוח", done: "הושלמו ב-24 השעות האחרונות", snoozed: (n: number) => `${n} נדחו לזמן מאוחר יותר`,
    empty: "אין משימות פתוחות. כל הכבוד!", blocked: "חסום", overdue: "באיחור", stale: "ממתין זמן רב", sort: "מיון",
    sorts: { priority: "דחיפות", age: "ימים בהמתנה", date: "תאריך קבלה", city: "עיר", category: "סוג משימה", assignee: "אחראי" },
    open: "פתיחה", doneBtn: "בוצע", snooze: "דחייה ל-3 ימים", remind: "תזכורת", pause: "השהיית תזכורות", resume: "חידוש תזכורות",
    remindersSent: (n: number) => `${n} תזכורות נשלחו`, nextReminder: "התזכורת הבאה", ageDays: (n: number) => (n === 0 ? "היום" : n === 1 ? "אתמול" : `לפני ${n} ימים`),
    reason: "סיבה (נשמרת בהיסטוריה)", notApplicable: "לא רלוונטי", allCats: "כל הסוגים", noOwner: "ללא בעלים",
  },
  newUsers: "משתמשים חדשים (7 ימים)", noNewUsers: "אין נרשמים חדשים השבוע.",
  party: { admin: "מנהל", user: "לקוח", appraiser: "שמאי", system: "מערכת" },
  priority: { 1: "דחוף", 2: "גבוה", 3: "רגיל", 4: "נמוך" } as Record<number, string>,
  category: { review: "בדיקה", market: "נתוני שוק", documents: "מסמכים", media: "צילום", application: "פרטי הנכס", appraisal: "הערכה", full: "שומה מלאה", communication: "תקשורת" } as Record<string, string>,
  task: {
    review_new: () => "נכס חדש הוגש – לבדוק את הפרטים",
    tax_data: (d: any) => d?.pending ? `נדרש עדכון עסקאות מרשות המסים (${d.pending} חיפושים)` : "נדרש עדכון עסקאות מרשות המסים",
    market_refresh: () => "נתוני השוק מתיישנים – כדאי לרענן",
    "doc:floor_plan": () => "חסרה תכנית דירה",
    "doc:ownership": () => "חסר מסמך בעלות",
    "doc:building_permit": () => "חסר היתר בנייה (לשומה המלאה)",
    tour: (d: any) => (d?.done ? `סיור חלקי – חסרים ${d.missing} חדרים` : "לא צולם סיור בנכס"),
    size: () => "חסר שטח הדירה",
    address: () => "חסרה כתובת מלאה",
    verify_docs: (d: any) => `לבדוק מסמכים שהועלו${d?.pending?.length ? ` (${d.pending.length})` : ""}`,
    area_check: (d: any) => `פער שטחים: מדווח ${d?.b ?? "?"} מ״ר מול ${d?.a ?? "?"} מ״ר`,
    legal_check: () => "דווחו חריגות בנייה / הליך – לבדיקה",
    condition_review: () => "לבדוק את מצב הנכס מהסיור",
    prelim_generate: () => "להפיק הערכה ראשונית",
    prelim_review: () => "הערכה ראשונית ממתינה לאישורך",
    prelim_send: () => "לשלוח את ההערכה ללקוח",
    complete_application: (d: any) => `הלקוח עדיין ממלא את הפרטים (${d?.progress ?? 0}%)`,
    start_application: () => "נרשם/ה ועדיין לא הוסיף/ה נכס",
    user_responded: () => "הלקוח הגיב לבקשה שלך",
    accept_quote: () => "ממתין לאישור הצעת המחיר",
    full_next: (d: any) => ({
      send_quote: "בקשה לשומה מלאה – לשלוח הצעת מחיר", confirm_payment: "שומה מלאה – לאשר תשלום", assign_appraiser: "שומה מלאה – לשבץ שמאי מוסמך",
      start_work: "שומה מלאה – להתחיל עבודה", sign_off: "שומה מלאה – חתימת השמאי", deliver: "שומה חתומה – למסור ללקוח",
    } as Record<string, string>)[d?.step] ?? (String(d?.step).startsWith("item:") ? `שומה מלאה – ${CHECK_HE[String(d.step).slice(5)] ?? d.step.slice(5)}` : "שומה מלאה"),
    clarify: (d: any) => `ממתין לתשובת הלקוח: ${d?.subject ?? ""}`,
  } as Record<string, (d?: any) => string>,
  blocked: { market: "אין מספיק עסקאות", address: "חסרה כתובת" } as Record<string, string>,
  props: {
    search: "חיפוש לפי כתובת, מספר בקשה, שם או דוא״ל", allStatuses: "כל הסטטוסים", allServices: "כל סוגי השירות", needsAttention: "דורשים טיפול", staleOnly: "ממתינים זמן רב",
    cols: { id: "מס׳", address: "נכס", owner: "מגיש", type: "סוג", size: "שטח", submitted: "הוגש", updated: "עודכן", service: "שירות", completion: "השלמה", confidence: "ביטחון", status: "סטטוס", tasks: "פתוחות", assignee: "אחראי", waiting: "ממתין" },
    free: "ראשונית", full: "מלאה", count: (n: number, t: number) => `${n} מתוך ${t} נכסים`, none: "אין נכסים שמתאימים לסינון.",
    tasksOpen: (a: number, u: number) => `${a} שלנו · ${u} אצל הלקוח`, days: (n: number) => `${n} ימים`,
  },
  types: { apartment: "דירה", garden_apartment: "דירת גן", penthouse: "פנטהאוז", duplex: "דופלקס", detached: "בית פרטי", semi_detached: "דו־משפחתי", cottage: "קוטג׳", townhouse: "בית טורי", house_on_plot: "בית על מגרש", other: "אחר" } as Record<string, string>,
  level: { low: "נמוך", moderate: "בינוני", good: "טוב", high: "גבוה" } as Record<string, string>,
  fresh: { fresh: "עדכני", review: "לבדיקה", outdated: "לא עדכני", none: "אין נתונים" } as Record<string, string>,
  conf: { high: "גבוה", medium: "בינוני", low: "נמוך", insufficient: "לא מספיק", none: "אין" } as Record<string, string>,
  wb: {
    tabs: { overview: "סקירה", tasks: "משימות", documents: "מסמכים", media: "חדרים ומדיה", market: "נתוני שוק", appraisal: "הערכה", comms: "תקשורת", history: "היסטוריה" },
    completion: "השלמת הבקשה", completionHelp: "כמה פרטים הלקוח מסר", confidence: "ביטחון בהערכה", confidenceHelp: "כמה הראיות אמינות ומספיקות",
    assignee: "אחראי", unassigned: "לא משויך", owner: "מגיש", noOwner: "אין חשבון לקוח", changeStatus: "שינוי סטטוס", overrideReason: "סיבת השינוי",
    action: {
      start_review: "התחלת טיפול", upload_market: "העלאת עסקאות מרשות המסים", generate: "הפקת הערכה ראשונית", approve: "בדיקה ואישור ההערכה", send: "שליחת ההערכה ללקוח",
      request_info: "בקשת פרטים מהלקוח", send_quote: "שליחת הצעת מחיר", confirm_payment: "עדכון תשלום", assign_appraiser: "שיבוץ שמאי", deliver: "מסירת השומה",
      full_work: "המשך השומה המלאה", close: "סגירת התיק", none: "אין פעולה נדרשת",
    } as Record<string, string>,
    facts: "פרטי הנכס", flags: "פערים שזוהו", components: "רכיבי הביטחון", limitations: "מגבלות שיוצגו בדו״ח",
    comp: { identification: "זיהוי הנכס", physical: "פרטים פיזיים", registered_area: "שטח רשום", ownership: "בעלות", floor_plan: "תכנית דירה", legal: "תכנון ורישוי", condition: "מצב (סיור)", market: "עסקאות השוואה", verification: "אימות מסמכים" } as Record<string, string>,
    openTasks: "משימות פתוחות", closedTasks: "משימות שנסגרו", closedBy: (who: string, how: string) => `נסגר ע״י ${who}${how ? ` – ${how}` : ""}`,
    docs: "מסמכים שהועלו", missingDocs: "מסמכים חסרים", verified: "נבדק", unverified: "טרם נבדק", markChecked: "סימון כנבדקו", noDocs: "לא הועלו מסמכים.", download: "פתיחה",
    media: "צילומי הסיור", mediaProgress: (d: number, t: number) => `${d} מתוך ${t} חדרים צולמו`, aiSoon: "ניתוח מצב אוטומטי מהווידאו יתווסף בהמשך – כרגע הבדיקה ידנית.", noMedia: "עדיין לא צולם.",
    market: {
      city: "שוק העיר", lastChecked: "המקור נבדק לאחרונה", latestDeal: "העסקה האחרונה בספרייה", deals12m: "עסקאות ב-12 חודשים", nearby: (r: number, m: number) => `עסקאות בטווח ${r} מ׳ ב-${m} חודשים`,
      level: "רמת הראיות", searchInfo: "פרטי חיפוש ברשות המסים", openSite: "פתיחת אתר מידע נדל״ן של רשות המסים", noResults: "החיפוש בוצע – אין תוצאות שימושיות",
      noResultsReason: "מה נבדק? (נשמר בהיסטוריה)", reused: (n: number) => `${n} עסקאות כבר קיימות בספרייה המשותפת ומשמשות לנכס הזה – אין צורך לחפש אותן שוב.`,
      insufficient: "אין מספיק עסקאות בסביבה – לא תופק הערכה עד שיתווספו נתונים.", by: { tax_upload: "העלאה מרשות המסים", sync: "סנכרון אוטומטי" } as Record<string, string>,
      fields: { address: "כתובת", city: "עיר", neighbourhood: "שכונה", block: "גוש", parcel: "חלקה", sub: "תת־חלקה", type: "סוג נכס", area: "שטח מדווח", radius: "רדיוס", period: "טווח תאריכים מוצע" },
    },
    appraisal: {
      generate: "הפקת הערכה ראשונית", regenerate: "הפקה מחדש", blockedMarket: "אין מספיק עסקאות השוואה – יש להעלות נתונים מרשות המסים קודם.",
      insufficient: "המערכת לא מצאה די עסקאות השוואה ולא הפיקה שווי. אין להמציא נתונים – העלו עסקאות נוספות.", range: "טווח שווי", point: "אומדן",
      compConf: "ביטחון בעסקאות", readiness: "ביטחון כולל", comparables: "עסקאות שנבחרו", approve: "אישור", send: "שליחה ללקוח", reject: "דחייה",
      status: { draft: "טיוטה – ממתינה לאישור", approved: "אושרה – טרם נשלחה", sent: "נשלחה ללקוח", superseded: "הוחלפה" } as Record<string, string>,
      disclaimer: "הערכה ראשונית, ללא ביקור בנכס בהכרח, ואינה מחליפה שומה של שמאי מקרקעין מוסמך.", evidence: "עסקאות ההשוואה", none: "עדיין לא הופקה הערכה.",
      cols: { address: "כתובת", date: "תאריך", price: "מחיר", area: "שטח", distance: "מרחק" },
    },
    full: {
      title: "שומה מלאה", open: "פתיחת שומה מלאה", purpose: "מטרת השומה", quote: "הצעת מחיר (₪)", payment: "תשלום", appraiser: "שמאי מוסמך (דוא״ל)", checklist: "רשימת בדיקות",
      addItem: "הוספת בדיקה", none: "לא הוזמנה שומה מלאה.", save: "שמירה", paymentAdapter: "אין עדיין חיבור לספק תשלומים – סטטוס התשלום מתעדכן ידנית.",
      to: { quoted: "שליחת הצעה", accepted: "הלקוח אישר", in_progress: "התחלת עבודה", signed: "השמאי חתם", delivered: "נמסר ללקוח", cancelled: "ביטול" } as Record<string, string>,
    },
    comms: {
      messages: "הודעות שנשלחו", none: "לא נשלחו הודעות.", reminders: "תזכורות פתוחות", compose: "בקשת השלמה מהלקוח", subject: "נושא", text: "הודעה",
      step: "קישור ישיר אל", send: "שליחה", retry: "שליחה חוזרת", attempts: (n: number) => `${n} ניסיונות`, optOut: "הלקוח ביקש לא לקבל תזכורות",
      preview: "תזכורת – אפשר לערוך לפני שליחה",
    },
    notes: "הערות פנימיות", notesHelp: "גלויות למנהלים בלבד – הלקוח לא רואה אותן.", addNote: "הוספת הערה", history: "היסטוריית פעילות",
  },
  steps: { setup: "פתיחה", location: "מיקום", property: "פרטי הנכס", legal: "משפטי ומסמכים", occupancy: "שימוש", tour: "סיור", review: "סיכום", result: "תוצאה" } as Record<string, string>,
  msgKind: { welcome: "ברוכים הבאים", reminder: "תזכורת", prelim_ready: "הערכה מוכנה", clarify: "בקשת השלמה", custom: "הודעה אישית", full_received: "אישור בקשה לשומה", full_quote: "הצעת מחיר", admin_new_user: "התראה: משתמש חדש", admin_full_request: "התראה: שומה מלאה" } as Record<string, string>,
  msgStatus: { queued: "בתור", sent: "נשלח", failed: "נכשל", not_sent: "לא נשלח (אין שירות דוא״ל)", suppressed: "לא נשלח (ביטל תזכורות)", cancelled: "בוטל" } as Record<string, string>,
  ev: {
    submitted: "הנכס הוגש", task_created: "נפתחה משימה", task_done: "משימה נסגרה", task_reopened: "משימה נפתחה מחדש", task_dismiss: "משימה סומנה כלא רלוונטית", task_snooze: "משימה נדחתה",
    task_assign: "משימה שויכה", task_pause: "תזכורות הושהו", task_resume: "תזכורות חודשו", task_reopen: "משימה נפתחה מחדש", task_opened: "נפתחה משימה ידנית", task_step: "שלב חדש בשומה המלאה", task_note: "הערה למשימה",
    applicant_activity: "פעילות של הלקוח", document_added: "הועלה מסמך", review_started: "התחיל טיפול", status_override: "שינוי סטטוס ידני", assigned: "שיוך אחראי",
    prelim_generated: "הופקה הערכה ראשונית", prelim_insufficient: "אין די עסקאות להערכה", prelim_approved: "ההערכה אושרה", prelim_sent: "ההערכה נשלחה ללקוח", prelim_rejected: "ההערכה נדחתה",
    full_requested: "הוזמנה שומה מלאה", full_updated: "עדכון בשומה המלאה", message_queued: "הודעה נכנסה לתור", message_sent: "הודעה נשלחה", message_not_sent: "הודעה לא נשלחה", message_failed: "שליחת הודעה נכשלה",
    message_retry: "שליחה חוזרת", reminder_sent: "נשלחה תזכורת", note_added: "נוספה הערה פנימית", market_upload: "הועלו עסקאות מרשות המסים", market_no_results: "חיפוש ללא תוצאות שימושיות",
    user_registered: "משתמש חדש נרשם", reminders_opt_out: "ביטל תזכורות", reminders_opt_in: "חידש תזכורות",
  } as Record<string, string>,
  what: { details: "עדכן פרטים", tour: "צילם", document: "העלה מסמך" } as Record<string, string>,
  users: {
    search: "חיפוש לפי שם, דוא״ל או טלפון", cols: { name: "שם", email: "דוא״ל", phone: "טלפון", role: "תפקיד", registered: "נרשם", lastSeen: "פעילות אחרונה", lang: "שפה", properties: "נכסים", welcome: "ברוכים הבאים", open: "בקשות פתוחות" },
    noProps: "ללא נכס", filters: { all: "כולם", noProperty: "בלי נכס", drafts: "עם טיוטה", active: "עם נכס שהוגש" }, count: (n: number) => `${n} משתמשים`,
    resendWelcome: "שליחת ברוכים הבאים שוב", message: "הודעה אישית", optOut: "לא לשלוח תזכורות", properties: "הנכסים", messages: "היסטוריית הודעות", none: "אין משתמשים.",
    detailsTitle: "פרטים", admin: "מנהל",
  },
  settings: {
    title: "הגדרות", market: "עדכניות נתוני שוק", freshDays: "עדכני עד (ימים מאז הבדיקה)", outdatedDays: "לא עדכני אחרי (ימים)", radius: "רדיוס עסקאות לבדיקה (מ׳)", months: "חודשים אחורה",
    reminders: "תזכורות ללקוחות", remindersOn: "שליחת תזכורות אוטומטית", reminderDays: "ימים מהבקשה (מופרד בפסיקים)", staleDays: "סימון ״ממתין זמן רב״ אחרי (ימים)",
    email: "שליחת דוא״ל", emailOn: (v: string) => `מחובר (${v})`, emailOff: "לא מחובר – הודעות נשמרות כ״לא נשלח״.",
    emailHow: "כדי לחבר: פתחו חשבון ב-Resend, אמתו את הדומיין beitsham.ai, והוסיפו לקובץ ‎.env בשרת: RESEND_API_KEY=… ו-MAIL_FROM=\"Beit Shamai <no-reply@beitsham.ai>\". לאחר מכן הריצו update.sh.",
    retryUnsent: "שליחת כל ההודעות שלא נשלחו", publicUrl: "כתובת האתר בקישורים", save: "שמירה", saved: "נשמר", admins: "מנהלים (ADMIN_EMAILS)", runNow: "הרצת בדיקה עכשיו",
  },
  reports: {
    title: "דוחות", users: "משתמשים חדשים בשבוע", properties: "נכסים חדשים בשבוע", submitted: "בקשות שהוגשו", toPrelim: "זמן ממוצע עד הערכה ראשונית", taxWait: "זמן ממוצע להעלאת נתוני רשות המסים",
    reminders: "תזכורות שנשלחו", docsUploaded: "מסמכים חסרים שהועלו לאחר בקשה", fullEnq: "פניות לשומה מלאה", fullPaid: "הומרו לשומה בתשלום", completed: "הערכות שנמסרו",
    workload: "עומס פתוח לפי סוג", days: (n: number | null) => (n === null ? "—" : `${n} ימים`), notSent: (n: number) => `${n} לא נשלחו`,
  },
  common: { save: "שמירה", cancel: "ביטול", send: "שליחה", loading: "טוען…", refresh: "רענון", error: "שגיאה", confirm: "אישור", by: "ע״י", on: "ב-", yes: "כן", no: "לא" },
  purposes: { bank: "בנק / משכנתא", sale: "מכירה", purchase: "רכישה", tax: "מיסוי", litigation: "הליך משפטי", inheritance: "ירושה / חלוקה", other: "אחר" } as Record<string, string>,
  payments: { none: "לא נדרש עדיין", pending: "ממתין לתשלום", paid: "שולם", waived: "פטור" } as Record<string, string>,
  fullStatus: { requested: "התקבלה בקשה", quoted: "נשלחה הצעה", accepted: "הלקוח אישר", in_progress: "בעבודה", signed: "נחתמה", delivered: "נמסרה", cancelled: "בוטלה" } as Record<string, string>,
};

const CHECK_HE: Record<string, string> = {
  verify_ownership: "אימות בעלות", verify_permit: "בדיקת היתר", verify_area: "אימות שטחים", inspection: "ביקור בנכס", comparables_review: "בחינת עסקאות השוואה",
  bank_format: "התאמה לפורמט הבנק", value_date: "שווי למועד הקובע", court_format: "פורמט לבית משפט", conflict_check: "בדיקת ניגוד עניינים", report_draft: "טיוטת שומה", sign_off: "חתימת שמאי",
};
const CHECK_EN: Record<string, string> = {
  verify_ownership: "Verify ownership", verify_permit: "Check building permit", verify_area: "Verify areas", inspection: "Site inspection", comparables_review: "Review comparables",
  bank_format: "Bank's report format", value_date: "Value at the relevant date", court_format: "Court format", conflict_check: "Conflict-of-interest check", report_draft: "Report draft", sign_off: "Appraiser sign-off",
};

type Texts = typeof he & { check: Record<string, string> };

const en: Texts = {
  nav: { home: "Dashboard", properties: "Properties", users: "Users", reports: "Reports", settings: "Settings", back: "← Back" },
  greet: (h: number) => (h < 12 ? "Good morning" : h < 17 ? "Good afternoon" : "Good evening"),
  summary: {
    lead: "Here's what's waiting today:",
    newProps: (n) => `${n} new properties awaiting review`, newUsers: (n) => `${n} new users this week`, urgent: (n) => `${n} urgent tasks`,
    market: (n) => `${n} properties waiting for Tax Authority deals`, approve: (n) => `${n} estimates awaiting your approval`, full: (n) => `${n} full-appraisal requests`,
    stale: (n, d) => `${n} properties waiting more than ${d} days`, calm: "Nothing urgent. A good time to look at properties waiting on clients.", first: "Start with:",
  },
  emailOff: (n) => `Email sending isn't connected yet – ${n} messages were not sent. They are kept and can be sent once a service is connected (Settings).`,
  stats: {
    users: "Registered users", usersNew: (t, w) => `${t} today · ${w} this week`, properties: "Properties", drafts: (n) => `${n} in draft`, newSubmissions: "New, awaiting review",
    attention: "Need attention", awaitingMarket: "Awaiting Tax Authority data", awaitingDocs: "Awaiting client documents", readyForPrelim: "Ready for a preliminary estimate",
    prelimAwaitingApproval: "Estimates awaiting approval", prelimDelivered: "Preliminary estimates delivered", fullRequested: "Full appraisals requested",
    fullInProgress: "Full appraisals in progress", completed: "Full appraisals completed",
  },
  queue: {
    title: "Action centre", mine: "Mine", all: "All", waiting: "Waiting on client", done: "Completed in the last 24 hours", snoozed: (n) => `${n} snoozed for later`,
    empty: "No open tasks. Well done!", blocked: "Blocked", overdue: "Overdue", stale: "Waiting long", sort: "Sort",
    sorts: { priority: "Priority", age: "Days waiting", date: "Date received", city: "City", category: "Task type", assignee: "Assignee" },
    open: "Open", doneBtn: "Done", snooze: "Snooze 3 days", remind: "Remind", pause: "Pause reminders", resume: "Resume reminders",
    remindersSent: (n) => `${n} reminders sent`, nextReminder: "Next reminder", ageDays: (n) => (n === 0 ? "today" : n === 1 ? "yesterday" : `${n} days ago`),
    reason: "Reason (kept in the history)", notApplicable: "Not applicable", allCats: "All types", noOwner: "No owner",
  },
  newUsers: "New users (7 days)", noNewUsers: "No new sign-ups this week.",
  party: { admin: "Admin", user: "Client", appraiser: "Appraiser", system: "System" },
  priority: { 1: "Urgent", 2: "High", 3: "Normal", 4: "Low" },
  category: { review: "Review", market: "Market data", documents: "Documents", media: "Filming", application: "Details", appraisal: "Estimate", full: "Full appraisal", communication: "Communication" },
  task: {
    review_new: () => "New property submitted – review the details",
    tax_data: (d) => (d?.pending ? `Tax Authority deals needed (${d.pending} searches)` : "Tax Authority deals needed"),
    market_refresh: () => "Market data ageing – consider a refresh",
    "doc:floor_plan": () => "Floor plan missing", "doc:ownership": () => "Ownership document missing", "doc:building_permit": () => "Building permit missing (full appraisal)",
    tour: (d) => (d?.done ? `Partial tour – ${d.missing} rooms missing` : "No tour filmed"), size: () => "Apartment area missing", address: () => "Full address missing",
    verify_docs: (d) => `Check uploaded documents${d?.pending?.length ? ` (${d.pending.length})` : ""}`,
    area_check: (d) => `Area discrepancy: reported ${d?.b ?? "?"} sqm vs ${d?.a ?? "?"} sqm`, legal_check: () => "Reported building deviations / proceedings – check",
    condition_review: () => "Review condition from the tour", prelim_generate: () => "Generate the preliminary estimate", prelim_review: () => "Preliminary estimate awaiting your approval",
    prelim_send: () => "Send the estimate to the client", complete_application: (d) => `Client still filling in details (${d?.progress ?? 0}%)`,
    start_application: () => "Registered, no property yet", user_responded: () => "The client responded to your request", accept_quote: () => "Waiting for quote acceptance",
    full_next: (d) => ({
      send_quote: "Full appraisal requested – send a quote", confirm_payment: "Full appraisal – confirm payment", assign_appraiser: "Full appraisal – assign a licensed appraiser",
      start_work: "Full appraisal – start work", sign_off: "Full appraisal – appraiser sign-off", deliver: "Signed appraisal – deliver to client",
    } as Record<string, string>)[d?.step] ?? (String(d?.step).startsWith("item:") ? `Full appraisal – ${CHECK_EN[String(d.step).slice(5)] ?? d.step.slice(5)}` : "Full appraisal"),
    clarify: (d) => `Waiting for the client: ${d?.subject ?? ""}`,
  },
  blocked: { market: "Not enough deals", address: "Address missing" },
  props: {
    search: "Search address, application no., name or email", allStatuses: "All statuses", allServices: "All services", needsAttention: "Need attention", staleOnly: "Waiting long",
    cols: { id: "No.", address: "Property", owner: "Applicant", type: "Type", size: "Area", submitted: "Submitted", updated: "Updated", service: "Service", completion: "Completion", confidence: "Confidence", status: "Status", tasks: "Open", assignee: "Assignee", waiting: "Waiting" },
    free: "Preliminary", full: "Full", count: (n, t) => `${n} of ${t} properties`, none: "No properties match the filter.", tasksOpen: (a, u) => `${a} ours · ${u} client`, days: (n) => `${n} days`,
  },
  types: { apartment: "Apartment", garden_apartment: "Garden flat", penthouse: "Penthouse", duplex: "Duplex", detached: "Detached house", semi_detached: "Semi-detached", cottage: "Cottage", townhouse: "Townhouse", house_on_plot: "House on plot", other: "Other" },
  level: { low: "Low", moderate: "Moderate", good: "Good", high: "High" },
  fresh: { fresh: "Current", review: "Needs review", outdated: "Outdated", none: "No data" },
  conf: { high: "High", medium: "Medium", low: "Low", insufficient: "Insufficient", none: "None" },
  wb: {
    tabs: { overview: "Overview", tasks: "To-do", documents: "Documents", media: "Rooms & media", market: "Market data", appraisal: "Appraisal", comms: "Communications", history: "History" },
    completion: "Application completion", completionHelp: "How much the client has provided", confidence: "Appraisal confidence", confidenceHelp: "How reliable and sufficient the evidence is",
    assignee: "Assignee", unassigned: "Unassigned", owner: "Applicant", noOwner: "No client account", changeStatus: "Change status", overrideReason: "Reason for the change",
    action: {
      start_review: "Start review", upload_market: "Upload Tax Authority deals", generate: "Generate preliminary estimate", approve: "Review and approve estimate", send: "Send estimate to client",
      request_info: "Request information", send_quote: "Send quote", confirm_payment: "Update payment", assign_appraiser: "Assign appraiser", deliver: "Deliver appraisal",
      full_work: "Continue full appraisal", close: "Close the file", none: "No action needed",
    },
    facts: "Property details", flags: "Discrepancies found", components: "Confidence components", limitations: "Limitations shown in the report",
    comp: { identification: "Identification", physical: "Physical details", registered_area: "Registered area", ownership: "Ownership", floor_plan: "Floor plan", legal: "Planning & permits", condition: "Condition (tour)", market: "Comparable sales", verification: "Document checks" },
    openTasks: "Open tasks", closedTasks: "Closed tasks", closedBy: (who, how) => `Closed by ${who}${how ? ` – ${how}` : ""}`,
    docs: "Uploaded documents", missingDocs: "Missing documents", verified: "Checked", unverified: "Not checked", markChecked: "Mark as checked", noDocs: "No documents uploaded.", download: "Open",
    media: "Tour shots", mediaProgress: (d, t) => `${d} of ${t} rooms filmed`, aiSoon: "Automatic condition analysis from video will be added later – for now the check is manual.", noMedia: "Nothing filmed yet.",
    market: {
      city: "City market", lastChecked: "Source last checked", latestDeal: "Newest deal in the library", deals12m: "Deals in 12 months", nearby: (r, m) => `Deals within ${r} m in ${m} months`,
      level: "Evidence level", searchInfo: "Tax Authority search details", openSite: "Open the Tax Authority property-information site", noResults: "Searched – no useful results",
      noResultsReason: "What was checked? (kept in the history)", reused: (n) => `${n} deals already in the shared library are used for this property – no need to search for them again.`,
      insufficient: "Not enough deals nearby – no estimate until more data is added.", by: { tax_upload: "Tax Authority upload", sync: "Automatic sync" },
      fields: { address: "Address", city: "City", neighbourhood: "Neighbourhood", block: "Block", parcel: "Parcel", sub: "Sub-parcel", type: "Property type", area: "Reported area", radius: "Radius", period: "Suggested date range" },
    },
    appraisal: {
      generate: "Generate preliminary estimate", regenerate: "Generate again", blockedMarket: "Not enough comparable sales – upload Tax Authority data first.",
      insufficient: "Not enough comparable sales were found, so no value was produced. Nothing is invented – add more deals.", range: "Value range", point: "Estimate",
      compConf: "Comparables confidence", readiness: "Overall confidence", comparables: "Deals used", approve: "Approve", send: "Send to client", reject: "Reject",
      status: { draft: "Draft – awaiting approval", approved: "Approved – not sent", sent: "Sent to client", superseded: "Superseded" },
      disclaimer: "Preliminary estimate, not necessarily with a site visit, and not a substitute for a valuation by a licensed appraiser.", evidence: "Comparable sales", none: "No estimate generated yet.",
      cols: { address: "Address", date: "Date", price: "Price", area: "Area", distance: "Distance" },
    },
    full: {
      title: "Full appraisal", open: "Open full appraisal", purpose: "Purpose", quote: "Quote (₪)", payment: "Payment", appraiser: "Licensed appraiser (email)", checklist: "Checklist",
      addItem: "Add item", none: "No full appraisal requested.", save: "Save", paymentAdapter: "No payment provider connected yet – payment status is updated by hand.",
      to: { quoted: "Send quote", accepted: "Client accepted", in_progress: "Start work", signed: "Appraiser signed", delivered: "Delivered", cancelled: "Cancel" },
    },
    comms: {
      messages: "Messages", none: "No messages yet.", reminders: "Open reminders", compose: "Ask the client for information", subject: "Subject", text: "Message",
      step: "Direct link to", send: "Send", retry: "Send again", attempts: (n) => `${n} attempts`, optOut: "The client opted out of reminders", preview: "Reminder – edit before sending",
    },
    notes: "Internal notes", notesHelp: "Visible to admins only – never shown to the client.", addNote: "Add note", history: "Activity history",
  },
  steps: { setup: "Start", location: "Location", property: "Property", legal: "Legal & documents", occupancy: "Use", tour: "Tour", review: "Summary", result: "Result" },
  msgKind: { welcome: "Welcome", reminder: "Reminder", prelim_ready: "Estimate ready", clarify: "Information request", custom: "Personal message", full_received: "Full request received", full_quote: "Quote", admin_new_user: "Alert: new user", admin_full_request: "Alert: full appraisal" },
  msgStatus: { queued: "Queued", sent: "Sent", failed: "Failed", not_sent: "Not sent (no email service)", suppressed: "Not sent (opted out)", cancelled: "Cancelled" },
  ev: {
    submitted: "Property submitted", task_created: "Task opened", task_done: "Task closed", task_reopened: "Task reopened", task_dismiss: "Task marked not applicable", task_snooze: "Task snoozed",
    task_assign: "Task assigned", task_pause: "Reminders paused", task_resume: "Reminders resumed", task_reopen: "Task reopened", task_opened: "Manual task opened", task_step: "Full appraisal: next step", task_note: "Task note",
    applicant_activity: "Client activity", document_added: "Document uploaded", review_started: "Review started", status_override: "Status changed by hand", assigned: "Assignee set",
    prelim_generated: "Preliminary estimate generated", prelim_insufficient: "Not enough deals for an estimate", prelim_approved: "Estimate approved", prelim_sent: "Estimate sent to client", prelim_rejected: "Estimate rejected",
    full_requested: "Full appraisal requested", full_updated: "Full appraisal updated", message_queued: "Message queued", message_sent: "Message sent", message_not_sent: "Message not sent", message_failed: "Message failed",
    message_retry: "Message resent", reminder_sent: "Reminder sent", note_added: "Internal note added", market_upload: "Tax Authority deals uploaded", market_no_results: "Search with no useful results",
    user_registered: "New user registered", reminders_opt_out: "Opted out of reminders", reminders_opt_in: "Opted back in to reminders",
  },
  what: { details: "updated details", tour: "filmed", document: "uploaded a document" },
  users: {
    search: "Search name, email or phone", cols: { name: "Name", email: "Email", phone: "Phone", role: "Role", registered: "Registered", lastSeen: "Last active", lang: "Language", properties: "Properties", welcome: "Welcome", open: "Open requests" },
    noProps: "No property", filters: { all: "All", noProperty: "No property", drafts: "With a draft", active: "With a submitted property" }, count: (n) => `${n} users`,
    resendWelcome: "Resend welcome email", message: "Personal message", optOut: "Don't send reminders", properties: "Properties", messages: "Message history", none: "No users.", detailsTitle: "Details", admin: "Admin",
  },
  settings: {
    title: "Settings", market: "Market data freshness", freshDays: "Current for (days since checked)", outdatedDays: "Outdated after (days)", radius: "Deal radius for the check (m)", months: "Months back",
    reminders: "Client reminders", remindersOn: "Send reminders automatically", reminderDays: "Days after the request (comma-separated)", staleDays: "Flag \"waiting long\" after (days)",
    email: "Email sending", emailOn: (v) => `Connected (${v})`, emailOff: "Not connected – messages are kept as \"not sent\".",
    emailHow: "To connect: open a Resend account, verify the beitsham.ai domain, and add to the server's .env: RESEND_API_KEY=… and MAIL_FROM=\"Beit Shamai <no-reply@beitsham.ai>\". Then run update.sh.",
    retryUnsent: "Send all unsent messages", publicUrl: "Site address used in links", save: "Save", saved: "Saved", admins: "Admins (ADMIN_EMAILS)", runNow: "Run checks now",
  },
  reports: {
    title: "Reports", users: "New users per week", properties: "New properties per week", submitted: "Applications submitted", toPrelim: "Average time to preliminary estimate", taxWait: "Average wait for Tax Authority uploads",
    reminders: "Reminders sent", docsUploaded: "Missing documents later uploaded", fullEnq: "Full-appraisal enquiries", fullPaid: "Converted to paid appraisals", completed: "Estimates delivered",
    workload: "Open workload by type", days: (n) => (n === null ? "—" : `${n} days`), notSent: (n) => `${n} not sent`,
  },
  common: { save: "Save", cancel: "Cancel", send: "Send", loading: "Loading…", refresh: "Refresh", error: "Error", confirm: "Confirm", by: "by", on: "on", yes: "Yes", no: "No" },
  purposes: { bank: "Bank / mortgage", sale: "Sale", purchase: "Purchase", tax: "Taxation", litigation: "Litigation", inheritance: "Inheritance / division", other: "Other" },
  payments: { none: "Not yet required", pending: "Awaiting payment", paid: "Paid", waived: "Waived" },
  fullStatus: { requested: "Request received", quoted: "Quote sent", accepted: "Client accepted", in_progress: "In progress", signed: "Signed", delivered: "Delivered", cancelled: "Cancelled" },
  check: CHECK_EN,
};

const HE: Texts = { ...he, check: CHECK_HE };
export const ADMIN_TEXT: Record<Lang, Texts> = { he: HE, en };

export function useAT() {
  const { lang, f } = useT();
  return { A: ADMIN_TEXT[lang as Lang], lang: lang as Lang, f };
}

/** A task's title in the admin's language. */
export function taskTitle(A: Texts, key: string, data?: any): string {
  if (key.startsWith("clarify:")) return A.task.clarify!(data);
  return A.task[key]?.(data) ?? key;
}

// How the page connects to the draft data. Choose ONE backend.
//
// 1) Firebase (after you deploy it; see README → "Moving to Firebase"):
//    paste your Firebase web config here and set DRAFT_API_URL to the "api" function URL.
window.FIREBASE_CONFIG = null;
// window.FIREBASE_CONFIG = {
//   apiKey: "…",
//   authDomain: "your-project.firebaseapp.com",
//   projectId: "your-project",
//   appId: "…"
// };
//
// 2) Google Sheet (current): the Apps Script Web app URL.
// While DRAFT_API_URL is empty, the page runs in DEMO MODE with sample data.
window.DRAFT_API_URL = "https://script.google.com/macros/s/AKfycbwXRmIHah8B__4dXCwCUODHPJDdDTDcS8x6Z1ZUNjlHx_fryV6wdy3fu-PcN7en2nMb/exec";

// How often (seconds) the board refreshes when live updates aren't available.
window.DRAFT_REFRESH_SECONDS = 10;

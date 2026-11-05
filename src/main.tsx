import { createRoot } from "react-dom/client";
import { App } from "./ui/App";
import { VisitApp } from "./ui/VisitApp";

// A filming link (/?visit=<property file id>) opens only the guided tour for that property.
const visit = new URLSearchParams(location.search).get("visit");
createRoot(document.getElementById("root")!).render(visit && /^[A-Za-z0-9-]{16,64}$/.test(visit) ? <VisitApp caseId={visit} /> : <App />);

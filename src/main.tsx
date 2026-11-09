import { createRoot } from "react-dom/client";
import { App } from "./ui/App";
import { FilmApp } from "./ui/FilmApp";

// A filming link (/?film=<token>) opens only the room-by-room tour for that property.
const film = new URLSearchParams(location.search).get("film");
createRoot(document.getElementById("root")!).render(film && /^[A-Za-z0-9_-]{16,80}$/.test(film) ? <FilmApp token={film} /> : <App />);

import { Outlet } from "react-router-dom";
import "./App.css";
import { ChatWidget } from "./components/ChatWidget";
import { TopBar } from "./components/TopBar";
import { Sidebar } from "./components/Sidebar";

function App() {
  return (
    <div className="brs-app">
      <TopBar />
      <Sidebar />
      <main className="main-area">
        <Outlet />
        <ChatWidget />
        <div className="footer-scroll-hint">
          <button type="button" className="scroll-hint-btn" aria-label="Scroll for more">
            <span aria-hidden>↓</span>
          </button>
        </div>
      </main>
    </div>
  );
}

export default App;

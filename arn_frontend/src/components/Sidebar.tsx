import { NavLink } from "react-router-dom";

function NavDot({ color }: { color: "purple" | "teal" | "coral" | "gray" }) {
  return <span className={`nav-dot nav-dot--${color}`} aria-hidden />;
}

export function Sidebar() {
  const linkClass = ({ isActive }: { isActive: boolean }) =>
    `sidebar-link${isActive ? " sidebar-link--active" : ""}`;

  return (
    <aside className="sidebar">
      <nav className="sidebar-nav" aria-label="Workspace">
        <p className="sidebar-nav__section">Workspace</p>
        <ul>
          <li>
            <NavLink className={linkClass} to="/" end>
              <NavDot color="purple" />
              Dashboard
            </NavLink>
          </li>
          <li>
            <NavLink className={linkClass} to="/submit">
              <NavDot color="gray" />
              Submit BRS
            </NavLink>
          </li>
          <li>
            <NavLink
              className={({ isActive }) =>
                `sidebar-link${isActive ? " sidebar-link--active" : ""}`
              }
              to="/submissions"
            >
              <NavDot color="gray" />
              All submissions
            </NavLink>
          </li>
        </ul>

       

       

       
      </nav>
    </aside>
  );
}

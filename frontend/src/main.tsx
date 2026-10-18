import { StrictMode, lazy, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { LazyMotion, domAnimation } from "motion/react";
import "./index.css";
import { SurveyFlow } from "@/features/survey/survey-flow";

// The admin console is a separate chunk so voters never download it.
const AdminPage = lazy(() => import("@/features/admin/admin-page"));

const isAdmin = window.location.pathname.replace(/\/+$/, "") === "/admin";

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    {/* LazyMotion + `m` components ship only the DOM animation features we use. */}
    <LazyMotion features={domAnimation} strict>
      {isAdmin ? (
        <Suspense fallback={null}>
          <AdminPage />
        </Suspense>
      ) : (
        <SurveyFlow />
      )}
    </LazyMotion>
  </StrictMode>,
);

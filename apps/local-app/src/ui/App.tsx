import { Routes, Route, Navigate } from 'react-router-dom';
import { Layout } from './components/Layout';
import { ProjectsPage } from './pages/ProjectsPage';
import { PromptsPage } from './pages/PromptsPage';
import { ProfilesPage } from './pages/ProfilesPage';
import { ProvidersPage } from './pages/ProvidersPage';
import { AgentsPage } from './pages/AgentsPage';
import { TeamsPage } from './pages/TeamsPage';
import { StatusesPage } from './pages/StatusesPage';
import { BoardPage } from './pages/BoardPage';
import { EpicDetailPage } from './pages/EpicDetailPage';
import { ChatPage } from './pages/ChatPage';
import { SettingsPage } from './pages/SettingsPage';
import { EventsPage } from './pages/EventsPage';
import { MessagesPage } from './pages/MessagesPage';
import { AutomationPage } from './pages/AutomationPage';
import { ReviewsPageWithSuspense } from './pages/ReviewsPage.lazy';
import { ReviewDetailPageWithSuspense } from './pages/ReviewDetailPage.lazy';
import { NotFoundPage } from './pages/NotFoundPage';
import { DocumentsDisabledPage } from './pages/DocumentsDisabledPage';
import { ProjectSelectionProvider } from './hooks/useProjectSelection';
import { RecordsDisabledPage } from './pages/RecordsDisabledPage';
import { RegistryPage } from './pages/RegistryPage';
import { SkillsPage } from './pages/SkillsPage';
import { WorktreesPage } from './pages/WorktreesPage';
import { CodebaseOverviewDisabledPage } from './pages/CodebaseOverviewDisabledPage';
import { RuntimeProvider, useRuntime } from './hooks/useRuntime';
import { CloudCallbackPage } from './components/cloud/CloudCallbackPage';
import { CloudPage } from './pages/CloudPage';

export function App() {
  return (
    <RuntimeProvider>
      <AppRoutes />
    </RuntimeProvider>
  );
}

function AppRoutes() {
  const { runtimeLoading, cloudUiEnabled } = useRuntime();
  const runtimeLoadingElement = (
    <div className="px-2 py-4 text-sm text-muted-foreground">Loading runtime...</div>
  );

  return (
    <Routes>
      {/* Cloud OAuth/magic-link callback — outside Layout */}
      <Route
        path="/auth/cloud/callback"
        element={
          runtimeLoading ? (
            runtimeLoadingElement
          ) : cloudUiEnabled ? (
            <CloudCallbackPage />
          ) : (
            <NotFoundPage />
          )
        }
      />

      {/* Main App Routes */}
      <Route
        path="/*"
        element={
          <ProjectSelectionProvider>
            <Layout>
              <Routes>
                <Route path="/" element={<Navigate to="/projects" replace />} />
                <Route path="/projects" element={<ProjectsPage />} />
                <Route path="/overview" element={<CodebaseOverviewDisabledPage />} />
                <Route path="/registry" element={<RegistryPage />} />
                <Route path="/skills" element={<SkillsPage />} />
                <Route path="/documents" element={<DocumentsDisabledPage />} />
                <Route path="/prompts" element={<PromptsPage />} />
                <Route path="/profiles" element={<ProfilesPage />} />
                <Route path="/providers" element={<ProvidersPage />} />
                <Route path="/agents" element={<AgentsPage />} />
                <Route path="/teams" element={<TeamsPage />} />
                <Route path="/statuses" element={<StatusesPage />} />
                <Route path="/board" element={<BoardPage />} />
                <Route
                  path="/chat"
                  element={runtimeLoading ? runtimeLoadingElement : <ChatPage />}
                />
                <Route
                  path="/reviews"
                  element={runtimeLoading ? runtimeLoadingElement : <ReviewsPageWithSuspense />}
                />
                <Route
                  path="/reviews/:reviewId"
                  element={
                    runtimeLoading ? runtimeLoadingElement : <ReviewDetailPageWithSuspense />
                  }
                />
                <Route path="/records" element={<RecordsDisabledPage />} />
                <Route path="/epics/:id" element={<EpicDetailPage />} />
                <Route path="/events" element={<EventsPage />} />
                <Route path="/messages" element={<MessagesPage />} />
                <Route path="/automation" element={<AutomationPage />} />
                <Route
                  path="/worktrees"
                  element={runtimeLoading ? runtimeLoadingElement : <WorktreesPage />}
                />
                <Route
                  path="/cloud"
                  element={
                    runtimeLoading ? (
                      runtimeLoadingElement
                    ) : cloudUiEnabled ? (
                      <CloudPage />
                    ) : (
                      <NotFoundPage />
                    )
                  }
                />
                <Route path="/settings" element={<SettingsPage />} />
                <Route path="*" element={<NotFoundPage />} />
              </Routes>
            </Layout>
          </ProjectSelectionProvider>
        }
      />
    </Routes>
  );
}

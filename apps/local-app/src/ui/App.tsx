import { Routes, Route, Navigate } from 'react-router-dom';
import { Layout } from './components/Layout';
import { ProjectsPage } from './pages/ProjectsPage';
import { PromptsPage } from './pages/PromptsPage';
import { ProfilesPage } from './pages/ProfilesPage';
import { ProvidersPage } from './pages/ProvidersPage';
import { AgentsPage } from './pages/AgentsPage';
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

export function App() {
  return (
    <Routes>
      {/* Main App Routes */}
      <Route
        path="/*"
        element={
          <ProjectSelectionProvider>
            <Layout>
              <Routes>
                <Route path="/" element={<Navigate to="/projects" replace />} />
                <Route path="/projects" element={<ProjectsPage />} />
                <Route path="/registry" element={<RegistryPage />} />
                <Route path="/documents" element={<DocumentsDisabledPage />} />
                <Route path="/prompts" element={<PromptsPage />} />
                <Route path="/profiles" element={<ProfilesPage />} />
                <Route path="/providers" element={<ProvidersPage />} />
                <Route path="/agents" element={<AgentsPage />} />
                <Route path="/statuses" element={<StatusesPage />} />
                <Route path="/board" element={<BoardPage />} />
                <Route path="/chat" element={<ChatPage />} />
                <Route path="/reviews" element={<ReviewsPageWithSuspense />} />
                <Route path="/reviews/:reviewId" element={<ReviewDetailPageWithSuspense />} />
                <Route path="/records" element={<RecordsDisabledPage />} />
                <Route path="/epics/:id" element={<EpicDetailPage />} />
                <Route path="/events" element={<EventsPage />} />
                <Route path="/messages" element={<MessagesPage />} />
                <Route path="/automation" element={<AutomationPage />} />
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

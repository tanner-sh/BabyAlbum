import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes } from 'react-router';
import { ApiError } from './api';
import { AdminLayout } from './pages/admin/AdminLayout';
import { LibraryPage } from './pages/admin/LibraryPage';
import { MembersPage } from './pages/admin/MembersPage';
import { PeoplePage } from './pages/admin/PeoplePage';
import { SettingsPage } from './pages/admin/SettingsPage';
import { AccountPage, InvitePage, LoginPage, SetupPage } from './pages/AuthPages';
import { BabyPage } from './pages/BabyPage';
import { AlbumPage, AlbumsPage } from './pages/AlbumsPage';
import { AssetPage } from './pages/AssetPage';
import { BookPage } from './pages/BookPage';
import { HealthPage } from './pages/admin/HealthPage';
import { SearchPage } from './pages/SearchPage';
import { DuplicatesPage } from './pages/admin/DuplicatesPage';
import { ComparePage } from './pages/ComparePage';
import { HomePage } from './pages/HomePage';
import { PhotosPage } from './pages/PhotosPage';
import { Layout } from './pages/Layout';
import { SharePage } from './pages/SharePage';
import { SharesPage } from './pages/SharesPage';
import { registerServiceWorker } from './pwa';
import './styles.css';

registerServiceWorker();

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      staleTime: 60_000,
      refetchOnWindowFocus: false,
      // 4xx 不重试
      retry: (count, err) => !(err instanceof ApiError && err.status < 500) && count < 2,
    },
  },
});

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route path="/setup" element={<SetupPage />} />
          <Route path="/login" element={<LoginPage />} />
          <Route path="/invite/:token" element={<InvitePage />} />
          <Route path="/s/:token" element={<SharePage />} />
          <Route element={<Layout />}>
            <Route index element={<HomePage />} />
            <Route path="baby/:id" element={<BabyPage />} />
            <Route path="baby/:id/book" element={<BookPage />} />
            <Route path="search" element={<SearchPage />} />
            <Route path="albums" element={<AlbumsPage />} />
            <Route path="albums/:id" element={<AlbumPage />} />
            <Route path="asset/:id" element={<AssetPage />} />
            <Route path="photos" element={<PhotosPage />} />
            <Route path="compare" element={<ComparePage />} />
            <Route path="shares" element={<SharesPage />} />
            <Route path="account" element={<AccountPage />} />
            <Route path="admin" element={<AdminLayout />}>
              <Route index element={<Navigate to="library" replace />} />
              <Route path="library" element={<LibraryPage />} />
              <Route path="people" element={<PeoplePage />} />
              <Route path="tidy" element={<DuplicatesPage />} />
              <Route path="health" element={<HealthPage />} />
              <Route path="members" element={<MembersPage />} />
              <Route path="settings" element={<SettingsPage />} />
            </Route>
          </Route>
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);

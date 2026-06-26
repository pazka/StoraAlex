import { Routes, Route, Navigate } from 'react-router-dom';
import { AuthProvider, RequireAuth } from './lib/auth.tsx';
import { Layout } from './components/Layout.tsx';
import { LoginPage } from './pages/Login.tsx';
import { ScanPage } from './pages/Scan.tsx';
import { ItemsPage } from './pages/Items.tsx';
import { ItemDetailPage } from './pages/ItemDetail.tsx';
import { ItemFormPage } from './pages/ItemForm.tsx';
import { PlacesPage } from './pages/Places.tsx';
import { PlaceDetailPage } from './pages/PlaceDetail.tsx';
import { PlaceFormPage } from './pages/PlaceForm.tsx';
import { TagsPage } from './pages/Tags.tsx';
import { MovementsPage } from './pages/Movements.tsx';
import { LabelsPage } from './pages/Labels.tsx';
import { UsersPage } from './pages/Users.tsx';

export function App() {
  return (
    <AuthProvider>
      <Routes>
        <Route path="/login" element={<LoginPage />} />
        <Route
          element={
            <RequireAuth>
              <Layout />
            </RequireAuth>
          }
        >
          <Route path="/" element={<ScanPage />} />
          <Route path="/items" element={<ItemsPage />} />
          <Route path="/items/new" element={<ItemFormPage />} />
          <Route path="/items/:id" element={<ItemDetailPage />} />
          <Route path="/items/:id/edit" element={<ItemFormPage />} />
          <Route path="/places" element={<PlacesPage />} />
          <Route path="/places/new" element={<PlaceFormPage />} />
          <Route path="/places/:id" element={<PlaceDetailPage />} />
          <Route path="/places/:id/edit" element={<PlaceFormPage />} />
          <Route path="/tags" element={<TagsPage />} />
          <Route path="/users" element={<UsersPage />} />
          <Route path="/history" element={<MovementsPage />} />
          <Route path="/labels" element={<LabelsPage />} />
          <Route path="*" element={<Navigate to="/" replace />} />
        </Route>
      </Routes>
    </AuthProvider>
  );
}

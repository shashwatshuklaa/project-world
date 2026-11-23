import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './contexts/AuthContext';
import { LoadingScreen } from './components/common/LoadingScreen';
import { ProtectedRoute } from './components/routes/ProtectedRoute';
import { GuestRoute } from './components/routes/GuestRoute';
import { MainLayout } from './components/layout/MainLayout';
import { HomePage } from './pages/HomePage';
import { ShopPage } from './pages/ShopPage';
import { ProjectDetailPage } from './pages/ProjectDetailPage';
import { CartPage } from './pages/CartPage';
import { OrderHistoryPage } from './pages/OrderHistoryPage';
import { OrderDetailPage } from './pages/OrderDetailPage';
import { LoginPage } from './pages/LoginPage';
import { SignupPage } from './pages/SignupPage';
import { ProfilePage } from './pages/ProfilePage';

export const App: React.FC = () => {
  const { isLoading } = useAuth();

  // Show loading screen while checking initial session cookie
  if (isLoading) {
    return <LoadingScreen />;
  }

  return (
    <Routes>
      {/* Routes utilizing the shared MainLayout (Navbar + Footer) */}
      <Route element={<MainLayout />}>
        <Route path="/" element={<HomePage />} />
        <Route path="/shop" element={<ShopPage />} />
        <Route path="/projects/:id" element={<ProjectDetailPage />} />
        <Route
          path="/cart"
          element={
            <ProtectedRoute>
              <CartPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/orders"
          element={
            <ProtectedRoute>
              <OrderHistoryPage />
            </ProtectedRoute>
          }
        />
        <Route
          path="/orders/:id"
          element={
            <ProtectedRoute>
              <OrderDetailPage />
            </ProtectedRoute>
          }
        />
      </Route>

      {/* Guest-only Routes (Standalone authentication layout) */}
      <Route
        path="/login"
        element={
          <GuestRoute>
            <LoginPage />
          </GuestRoute>
        }
      />
      <Route
        path="/signup"
        element={
          <GuestRoute>
            <SignupPage />
          </GuestRoute>
        }
      />

      {/* Protected Routes (Standalone account dashboard layout) */}
      <Route
        path="/profile"
        element={
          <ProtectedRoute>
            <ProfilePage />
          </ProtectedRoute>
        }
      />

      {/* Catch-all redirect to Home */}
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
};

export default App;

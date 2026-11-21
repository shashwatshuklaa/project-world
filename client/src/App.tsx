import React from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { useAuth } from './contexts/AuthContext';
import { LoadingScreen } from './components/common/LoadingScreen';
import { ProtectedRoute } from './components/routes/ProtectedRoute';
import { GuestRoute } from './components/routes/GuestRoute';
import { HomePage } from './pages/HomePage';
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
      {/* Public Route */}
      <Route path="/" element={<HomePage />} />

      {/* Guest-only Routes (redirect to profile/return path if already logged in) */}
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

      {/* Protected Routes (redirect to /login if unauthenticated) */}
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

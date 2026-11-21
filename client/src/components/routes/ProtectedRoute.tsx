import React, { ReactNode } from 'react';
import { Navigate, useLocation } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { LoadingScreen } from '../common/LoadingScreen';
import { UserRole } from '../../types/auth';

export interface ProtectedRouteProps {
  children: ReactNode;
  allowedRoles?: UserRole[];
}

/**
 * Reusable ProtectedRoute component.
 * - Displays LoadingScreen while session verification is in progress.
 * - Redirects unauthenticated users to /login, attaching the attempted location in router state.
 * - Supports role authorization (e.g., adminOnly) and redirects unauthorized users to home.
 * - Renders children when authenticated and authorized.
 */
export const ProtectedRoute: React.FC<ProtectedRouteProps> = ({
  children,
  allowedRoles,
}) => {
  const { user, isAuthenticated, isLoading } = useAuth();
  const location = useLocation();

  if (isLoading) {
    return <LoadingScreen />;
  }

  if (!isAuthenticated) {
    // Preserve requested route in location.state for redirect-back after login
    return <Navigate to="/login" state={{ from: location }} replace />;
  }

  // Role check if specific roles are required (e.g. 'admin')
  if (allowedRoles && user && !allowedRoles.includes(user.role)) {
    return <Navigate to="/" replace />;
  }

  return <>{children}</>;
};

export default ProtectedRoute;

import React, { ReactNode } from 'react';
import { Navigate, useLocation, Location } from 'react-router-dom';
import { useAuth } from '../../contexts/AuthContext';
import { LoadingScreen } from '../common/LoadingScreen';

export interface GuestRouteProps {
  children: ReactNode;
}

/**
 * Reusable GuestRoute component.
 * Restricts access to guest-only authentication pages like /login and /signup.
 * - Displays LoadingScreen while session verification is loading.
 * - If already authenticated, redirects back to the intended page (from location.state) or defaults to /profile.
 * - Guards against redirect loops by validating that the 'from' path is not an auth route.
 * - Renders children when unauthenticated.
 */
export const GuestRoute: React.FC<GuestRouteProps> = ({ children }) => {
  const { isAuthenticated, isLoading } = useAuth();
  const location = useLocation();

  if (isLoading) {
    return <LoadingScreen />;
  }

  if (isAuthenticated) {
    // Determine return destination, ensuring no redirect loops to auth pages
    const locationState = location.state as { from?: Location } | null;
    const requestedPath = locationState?.from?.pathname;
    const destination =
      requestedPath && requestedPath !== '/login' && requestedPath !== '/signup'
        ? requestedPath
        : '/profile';

    return <Navigate to={destination} replace />;
  }

  return <>{children}</>;
};

export default GuestRoute;

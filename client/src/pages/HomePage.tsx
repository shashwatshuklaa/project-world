import React from 'react';
import { Link } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';

export const HomePage: React.FC = () => {
  const { user, isAuthenticated, logout } = useAuth();

  return (
    <div className="min-h-screen bg-gray-50 p-8 text-gray-900">
      <header className="mx-auto flex max-w-4xl items-center justify-between border-b border-gray-200 pb-4">
        <h1 className="text-2xl font-bold tracking-tight text-blue-600">ProjectWorld</h1>
        <nav className="flex items-center space-x-4 text-sm font-medium">
          <Link to="/" className="text-gray-700 hover:text-blue-600">Home</Link>
          {isAuthenticated ? (
            <>
              <Link to="/profile" className="text-gray-700 hover:text-blue-600">Profile</Link>
              <button
                onClick={() => logout()}
                className="rounded bg-gray-200 px-3 py-1 hover:bg-gray-300"
              >
                Logout
              </button>
            </>
          ) : (
            <>
              <Link to="/login" className="text-gray-700 hover:text-blue-600">Login</Link>
              <Link
                to="/signup"
                className="rounded bg-blue-600 px-3 py-1 text-white hover:bg-blue-700"
              >
                Sign Up
              </Link>
            </>
          )}
        </nav>
      </header>

      <main className="mx-auto mt-12 max-w-4xl text-center">
        <h2 className="text-3xl font-extrabold text-gray-900 sm:text-4xl">
          Welcome to ProjectWorld
        </h2>
        <p className="mt-4 text-lg text-gray-600">
          Digital Marketplace for Academic, Engineering & Tech Projects.
        </p>

        <div className="mt-8 rounded-lg border border-gray-200 bg-white p-6 shadow-sm">
          <h3 className="text-lg font-semibold text-gray-800">Auth State Status</h3>
          <p className="mt-2 text-sm text-gray-600">
            Authenticated: <span className="font-mono font-bold">{isAuthenticated ? 'Yes' : 'No'}</span>
          </p>
          {user && (
            <p className="mt-1 text-sm text-gray-600">
              Logged in as: <span className="font-semibold text-blue-600">{user.name}</span> ({user.email}) - Role: <span className="font-mono text-xs uppercase">{user.role}</span>
            </p>
          )}
        </div>
      </main>
    </div>
  );
};

export default HomePage;

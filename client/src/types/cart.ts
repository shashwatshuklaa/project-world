export interface CartProject {
  id: string;
  slug?: string;
  _id: string;
  title: string;
  category: string;
  subcategory: string;
  price: number;
  image: string;
  difficulty?: string;
}

export interface CartItem {
  id: string;
  _id: string;
  project: CartProject;
  quantity: number;
  customization: string;
  unitPrice: number;
  itemTotal: number;
}

export interface CartData {
  items: CartItem[];
  subtotal: number;
  total: number;
  itemCount: number;
}

export interface CartApiResponse {
  success: boolean;
  message?: string;
  data: {
    cart: CartData;
  };
}

export interface AddCartItemInput {
  projectId: string;
  quantity?: number;
  customization?: string;
}

export interface UpdateCartItemInput {
  quantity?: number;
  customization?: string;
}

export interface CartContextType {
  cart: CartData | null;
  cartCount: number;
  cartTotal: number;
  isLoading: boolean;
  error: string | null;
  refreshCart: () => Promise<void>;
  addToCart: (projectId: string, quantity?: number, customization?: string) => Promise<void>;
  updateItem: (itemId: string, data: UpdateCartItemInput) => Promise<void>;
  removeItem: (itemId: string) => Promise<void>;
  clearCart: () => Promise<void>;
}

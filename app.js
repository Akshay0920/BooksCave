require('dotenv').config();
const express = require('express');
const axios = require('axios');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const admin = require('firebase-admin');
const db = require('./firebase');

const app = express();
app.use(express.static('public'));
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.set('view engine', 'ejs');
app.use(session({ secret: 'booksCaveSecret', resave: false, saveUninitialized: true }));

function isAuthenticated(req, res, next) {
  if (req.session.user) next();
  else res.redirect('/login');
}

function getRandomPrice() {
  return Math.floor(Math.random() * (5000 - 200 + 1)) + 200;
}

app.get('/', isAuthenticated, async (req, res) => {
  const searchQuery = req.query.search || 'books';
  try {
    const response = await axios.get(`https://www.googleapis.com/books/v1/volumes?q=${searchQuery}&maxResults=12&key=${process.env.GOOGLE_BOOKS_API}`);
    const books = (response.data.items || []).map(item => ({
      id: item.id,
      title: item.volumeInfo.title,
      authors: item.volumeInfo.authors?.join(', ') || 'Unknown',
      thumbnail: item.volumeInfo.imageLinks?.thumbnail || '',
      price: getRandomPrice(),
      discount: Math.floor(Math.random() * 40) + 10
    }));
    res.render('index', { books, searchQuery, showNavbar: true, currentPage: 'home' });
  } catch (error) {
    console.error('Error fetching books:', error.message);
    res.status(500).send('Error fetching books');
  }
});

app.get('/signup', (req, res) => { res.render('signup', { showNavbar: false }); });
app.post('/signup', async (req, res) => {
  const { username, email, password, confirmPassword } = req.body;
  if (password !== confirmPassword) return res.send('Passwords do not match');
  try {
    const hashedPassword = await bcrypt.hash(password, 10);
    const userRecord = await admin.auth().createUser({ email, password });
    await db.collection('users').doc(userRecord.uid).set({ username, email, password: hashedPassword });
    req.session.user = { uid: userRecord.uid, email, username };
    res.redirect('/');
  } catch (error) {
    console.error('Signup error:', error);
    res.status(500).send('Email already exists');
  }
});

app.get('/login', (req, res) => { res.render('login', { showNavbar: false }); });
app.post('/login', async (req, res) => {
  const { email, password } = req.body;
  try {
    const user = await admin.auth().getUserByEmail(email);
    const userDoc = await db.collection('users').doc(user.uid).get();
    if (!userDoc.exists) return res.send('User not found');
    const match = await bcrypt.compare(password, userDoc.data().password);
    if (!match) return res.send('Invalid login credentials');
    req.session.user = { uid: user.uid, email: user.email, username: userDoc.data().username };
    res.redirect('/');
  } catch (error) {
    console.error('Login error:', error);
    res.status(401).send('Invalid login');
  }
});

app.get('/logout', (req, res) => { req.session.destroy(); res.redirect('/login'); });

app.post('/add-to-cart', isAuthenticated, async (req, res) => {
  const { id, title, authors, thumbnail, price } = req.body;
  const userId = req.session.user.uid;
  try {
    const cartRef = db.collection('users').doc(userId).collection('cart');
    const existingDoc = await cartRef.doc(id).get();
    if (existingDoc.exists) await cartRef.doc(id).update({ quantity: existingDoc.data().quantity + 1 });
    else await cartRef.doc(id).set({ id, title, authors, thumbnail, price: parseInt(price), quantity: 1 });
    res.json({ success: true, message: 'Item added to cart successfully' });
  } catch (error) {
    console.error('Add to cart error:', error);
    res.status(500).json({ success: false, message: 'Failed to add to cart' });
  }
});

app.post('/buy-now', isAuthenticated, (req, res) => {
  const { id, title, authors, thumbnail, price } = req.body;
  const username = req.session.user.username;
  const cartItems = [{ id, title, authors, thumbnail, price: parseInt(price), quantity: 1 }];
  const totalPrice = cartItems.reduce((acc, item) => acc + item.price * item.quantity, 0);
  res.render('order-details', { cartItems, totalPrice, username, showNavbar: true, currentPage: 'cart' });
});

app.get('/cart', isAuthenticated, async (req, res) => {
  const userId = req.session.user.uid;
  try {
    const snapshot = await db.collection('users').doc(userId).collection('cart').get();
    const cartItems = snapshot.docs.map(doc => ({ ...doc.data(), docId: doc.id }));
    res.render('cart', { cartItems, showNavbar: false });
  } catch (error) {
    console.error('Cart fetch error:', error);
    res.status(500).send('Failed to load cart');
  }
});

app.post('/delete-from-cart', isAuthenticated, async (req, res) => {
  const userId = req.session.user.uid;
  const { docId } = req.body;
  try {
    await db.collection('users').doc(userId).collection('cart').doc(docId).delete();
    res.redirect('/cart');
  } catch (error) {
    console.error('Delete from cart error:', error);
    res.status(500).send('Failed to delete item');
  }
});

async function getUserCart(userId) {
  const snapshot = await db.collection('users').doc(userId).collection('cart').get();
  return snapshot.docs.map(doc => doc.data());
}

app.get('/checkout', isAuthenticated, async (req, res) => {
  const userId = req.session.user.uid;
  try {
    const cart = await getUserCart(userId);
    let address = null;

    if (req.session.selectedAddressId) {
      const doc = await db.collection('users')
        .doc(userId)
        .collection('addresses')
        .doc(req.session.selectedAddressId)
        .get();

      if (doc.exists) {
        address = { ...doc.data(), id: doc.id };  
      }
    }

    res.render('checkout', {
      cart,
      currentPage: 'checkout',
      address,
      showNavbar: false
    });
  } catch (error) {
    console.error('Checkout error:', error);
    res.status(500).send('Failed to load checkout');
  }
});


app.post('/confirm-order', isAuthenticated, async (req, res) => {
  const userId = req.session.user.uid;
  try {
    const snapshot = await db.collection('users').doc(userId).collection('cart').get();
    const cartItems = snapshot.docs.map(doc => ({ ...doc.data(), docId: doc.id }));
    const orderData = {
      userId,
      books: cartItems.map(item => ({ title: item.title, authors: item.authors, price: item.price, quantity: item.quantity })),
      totalAmount: cartItems.reduce((acc, item) => acc + item.price * item.quantity, 0),
      status: 'confirmed',
      createdAt: admin.firestore.FieldValue.serverTimestamp()
    };
    await db.collection('orders').add(orderData);
    const batch = db.batch();
    snapshot.docs.forEach(doc => batch.delete(doc.ref));
    await batch.commit();
    res.redirect('/checkout-success');
  } catch (error) {
    console.error('Confirm order error:', error);
    res.status(500).send('Failed to confirm order');
  }
});

app.get('/checkout-success', isAuthenticated, (req, res) => {
  res.render('checkout-success', { username: req.session.user.username, showNavbar: false });
});

app.get('/book/:id', isAuthenticated, async (req, res) => {
  const bookId = req.params.id;
  try {
    const response = await axios.get(`https://www.googleapis.com/books/v1/volumes/${bookId}?key=${process.env.GOOGLE_BOOKS_API}`);
    const book = response.data;
    const bookDetails = {
      id: book.id,
      title: book.volumeInfo.title || 'No title',
      authors: book.volumeInfo.authors?.join(', ') || 'Unknown',
      description: book.volumeInfo.description || 'No description available',
      thumbnail: book.volumeInfo.imageLinks?.thumbnail || '',
      publisher: book.volumeInfo.publisher || 'Unknown',
      publishedDate: book.volumeInfo.publishedDate || 'Unknown',
      pageCount: book.volumeInfo.pageCount || 'N/A',
      categories: book.volumeInfo.categories?.join(', ') || 'N/A',
      price: getRandomPrice(),
      discount: Math.floor(Math.random() * 40) + 10
    };
    res.render('book-details', { book: bookDetails, showNavbar: true });
  } catch (error) {
    console.error('Book details fetch error:', error);
    res.status(500).send('Error fetching book details');
  }
});

app.get('/orders', isAuthenticated, async (req, res) => {
  const userId = req.session.user.uid;
  try {
    const ordersSnapshot = await db.collection('orders').where('userId', '==', userId).orderBy('createdAt', 'desc').get();
    const orders = ordersSnapshot.docs.map(doc => ({ id: doc.id, ...doc.data(), createdAt: doc.data().createdAt?.toDate().toLocaleString() || 'N/A' }));
    const ratingsSnapshot = await db.collection('orderRatings').where('userId', '==', userId).get();
    const ratingsMap = {};
    ratingsSnapshot.docs.forEach(doc => { const data = doc.data(); ratingsMap[data.orderId] = data.rating; });
    res.render('order-history', { orders, ratingsMap, username: req.session.user.username, showNavbar: true, currentPage: 'orders' });
  } catch (error) {
    console.error('Error fetching orders or ratings:', error);
    res.status(500).send('Failed to load orders');
  }
});

app.post('/submit-rating', isAuthenticated, async (req, res) => {
  const userId = req.session.user.uid;
  const { orderId, rating } = req.body;
  if (!orderId || !rating) return res.status(400).send('Order ID and rating are required');
  try {
    const ratingDocRef = db.collection('orderRatings').doc(`${userId}_${orderId}`);
    await ratingDocRef.set({ userId, orderId, rating: parseInt(rating), createdAt: admin.firestore.FieldValue.serverTimestamp() });
    res.redirect('/orders');
  } catch (error) {
    console.error('Error saving rating:', error);
    res.status(500).send('Failed to save rating');
  }
});

app.get('/profile', isAuthenticated, async (req, res) => {
  const userId = req.session.user.uid;

  const userDoc = await db.collection('users').doc(userId).get();
  const user = userDoc.data();

  const addressesSnapshot = await db.collection('users').doc(userId).collection('addresses').get();
  const addresses = addressesSnapshot.docs.map(doc => ({ ...doc.data(), id: doc.id }));

  res.render('profile', {
    username: user.username,
    email: user.email,
    addresses,
    selectedAddressId: req.session.selectedAddressId || null,
    showNavbar: true,
    currentPage: 'profile',
    fromCheckout: req.query.from === 'checkout' 
  });
});


app.get('/add-address', isAuthenticated, (req, res) => {
  res.render('add-address', { address: null });
});


app.post('/submit-address', isAuthenticated, async (req, res) => {
  const userId = req.session.user?.uid;
  const { name, phone, pincode, locality, address, city, state, landmark, altPhone, type } = req.body;
  if (!userId) return res.status(400).send("User not logged in");
  try {
    await db.collection('users').doc(userId).collection('addresses').add({
      name, phone, pincode, locality, address, city, state, landmark, altPhone, type,
      createdAt: new Date()
    });
    res.redirect('/profile');
  } catch (error) {
    console.error("Error saving address:", error);
    res.status(500).send("Something went wrong.");
  }
});

app.get('/edit-address/:id', isAuthenticated, async (req, res) => {
  const userId = req.session.user.uid;
  const addressId = req.params.id;
  try {
    const addressDoc = await db.collection('users').doc(userId).collection('addresses').doc(addressId).get();
    if (!addressDoc.exists) return res.status(404).send('Address not found');
    const address = { id: addressDoc.id, ...addressDoc.data() };
    res.render('add-address', { address });
  } catch (error) {
    console.error('Error loading address for editing:', error);
    res.status(500).send('Failed to load address');
  }
});

app.post('/update-address/:id', isAuthenticated, async (req, res) => {
  const userId = req.session.user.uid;
  const addressId = req.params.id;
  try {
    await db.collection('users').doc(userId).collection('addresses').doc(addressId).update(req.body);
    res.redirect('/profile');
  } catch (err) {
    console.error('Error updating address:', err);
    res.status(500).send('Error updating address');
  }
});

app.get('/select-address/:id', isAuthenticated, async (req, res) => {
  const userId = req.session.user.uid;
  const addressId = req.params.id;
  const from = req.query.from;

  try {
    req.session.selectedAddressId = addressId;
    if (from === 'checkout') {
      res.redirect('/checkout');
    } else {
      res.redirect('/profile');
    }
  } catch (error) {
    console.error('Failed to select address:', error);
    res.status(500).send('Internal Server Error');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server started on port ${PORT}`));
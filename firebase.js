const firebaseConfig = {
  apiKey: "AIzaSyC1GnMIgYrtDCOy6Afu6MDDtZ8XNuIEbAo",
  authDomain: "solemate-cacd6.firebaseapp.com",
  projectId: "solemate-cacd6",
  storageBucket: "solemate-cacd6.firebasestorage.app",
  messagingSenderId: "943009353473",
  appId: "1:943009353473:web:1df8a149de528af272d500",
};

window.SolemateFirebaseReady = new Promise((resolve, reject) => {
  try {
    if (!window.firebase) {
      throw new Error("Firebase SDK가 아직 로드되지 않았어요.");
    }

    const app = window.firebase.apps.length
      ? window.firebase.app()
      : window.firebase.initializeApp(firebaseConfig);
    const auth = window.firebase.auth(app);
    const db = window.firebase.firestore(app);

    resolve({
      auth,
      db,
      collection: (database, path) => database.collection(path),
      createUserWithEmailAndPassword: (authInstance, email, password) =>
        authInstance.createUserWithEmailAndPassword(email, password),
      doc: (database, collectionPath, documentId) => database.collection(collectionPath).doc(documentId),
      getDoc: async (docRef) => {
        const snap = await docRef.get();
        return {
          id: snap.id,
          ref: snap.ref,
          data: () => snap.data(),
          exists: () => snap.exists,
        };
      },
      getDocs: (collectionRef) => collectionRef.get(),
      onAuthStateChanged: (authInstance, callback) => authInstance.onAuthStateChanged(callback),
      serverTimestamp: () => window.firebase.firestore.FieldValue.serverTimestamp(),
      setDoc: (docRef, data, options) => docRef.set(data, options),
      signInWithEmailAndPassword: (authInstance, email, password) =>
        authInstance.signInWithEmailAndPassword(email, password),
      signOut: (authInstance) => authInstance.signOut(),
      updateDoc: (docRef, data) => docRef.update(data),
      updateProfile: (user, profile) => user.updateProfile(profile),
    });
  } catch (error) {
    window.SolemateFirebaseError = error;
    reject(error);
  }
});

import mongoose from 'mongoose';
mongoose.connect(process.env.MONGO_URI);

const reportSchema = new mongoose.Schema({
  url: String,
  email: String,
  result: Object,
  type: String,
  createdAt: { type: Date, default: Date.now }
});

const Report = mongoose.model('Report', reportSchema);

export const saveReport = (data) => new Report(data).save();
export const getAllReports = () => Report.find().sort({ createdAt: -1 }).limit(100);
export const getReportById = (id) => Report.findById(id);
export const canScanToday = async (email) => {
  const last = await Report.findOne({ email, type: 'public' }).sort({ createdAt: -1 });
  if (!last) return true;
  const now = new Date();
  return (now - last.createdAt) > 24 * 60 * 60 * 1000;
};